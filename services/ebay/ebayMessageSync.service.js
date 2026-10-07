/**
 * eBay Message Sync (eBay → CRM Marketplace Inbox), incremental.
 *
 * Pulls only what changed since the CRM last saw each eBay conversation, so
 * the scheduled job (jobs/ebayMessageSyncJob.js) can run every few minutes
 * without loading the server or eBay's API quota:
 *
 *   1. Page through eBay conversation SUMMARIES (one call per 50
 *      conversations) — cheap, no message bodies.
 *   2. For each summary, decide from the CRM's own Conversation record
 *      whether it has anything new (latest message ID/time vs. what's
 *      stored). Unchanged conversations cost one indexed DB read, no eBay call.
 *   3. Only for changed conversations, fetch the messages and upsert them via
 *      the adapter's existing, idempotent _upsertMessage (duplicates are
 *      skipped by platformMessageId).
 *   4. Emit the same `new_message` Socket.io event the manual sync endpoint
 *      emits, once per genuinely new message, so open Marketplace Inboxes
 *      update live.
 *
 * Paging stops at the first page with no changes (eBay lists recent
 * conversations first), and every run is bounded by hard caps and a time
 * budget. Periodic "deep" runs ignore the early stop, as a safety net in
 * case an older conversation gets a new message.
 *
 * This file does not modify ebayAdapter.fetchMessages()/sync(), which the
 * existing manual endpoints keep using unchanged.
 */
const IntegrationAccount = require("../../models/IntegrationAccount.model");
const Conversation = require("../../models/Conversation.model");
const ebayAdapter = require("../adapters/ebayAdapter");
const { EbayAuthError } = require("../clients/ebayApiClient");

const LOG_PREFIX = "[EBAY_MESSAGE_SYNC]";

const toPositiveInt = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// eBay's documented maximum page size for getConversations.
const PAGE_SIZE = 50;
const MAX_PAGES = toPositiveInt(process.env.EBAY_MESSAGE_SYNC_MAX_PAGES, 3);
const MAX_DETAIL_FETCHES = toPositiveInt(process.env.EBAY_MESSAGE_SYNC_MAX_DETAILS, 20);
const TIME_BUDGET_MS = toPositiveInt(process.env.EBAY_MESSAGE_SYNC_TIME_BUDGET_MS, 90 * 1000);
const MAX_EVENTS_PER_RUN = 200;

// Last fingerprint processed per eBay conversation in this process. Stops a
// conversation whose summary can't be matched against stored message IDs
// from being re-fetched on every run.
const processedFingerprints = new Map();
const MAX_FINGERPRINTS = 5000;

function summaryLatest(summary) {
  const latest = summary?.latestMessage || {};
  const id = latest.messageId || latest.id || null;
  const rawAt = latest.createdDate || summary?.lastModifiedDate || summary?.updatedDate || null;
  const at = rawAt ? new Date(rawAt) : null;
  return { id, at: at && !Number.isNaN(at.getTime()) ? at : null };
}

function rememberFingerprint(conversationId, fingerprint) {
  if (!fingerprint) return;
  if (processedFingerprints.size >= MAX_FINGERPRINTS) processedFingerprints.clear();
  processedFingerprints.set(conversationId, fingerprint);
}

/**
 * Does this eBay conversation have anything the CRM hasn't stored yet?
 * Uses only indexed reads (platform + platformConversationId, and
 * messages.platformMessageId).
 */
async function hasNewActivity(summary) {
  const conversationId = summary.conversationId;
  const { id, at } = summaryLatest(summary);
  const fingerprint = id || (at ? at.toISOString() : null);

  if (fingerprint && processedFingerprints.get(conversationId) === fingerprint) {
    return { changed: false, fingerprint };
  }

  const existing = await Conversation.findOne({ platform: "ebay", platformConversationId: conversationId })
    .select("_id lastMessageAt")
    .lean();

  if (!existing) return { changed: true, fingerprint };

  if (id) {
    const known = await Conversation.exists({ _id: existing._id, "messages.platformMessageId": id });
    if (known) return { changed: false, fingerprint };
    // The ID may be formatted differently from stored messages; fall back to
    // the timestamp before deciding it's new.
    if (at && existing.lastMessageAt) {
      return { changed: at.getTime() > new Date(existing.lastMessageAt).getTime() + 1000, fingerprint };
    }
    return { changed: true, fingerprint };
  }

  if (at) {
    const changed = !existing.lastMessageAt || at.getTime() > new Date(existing.lastMessageAt).getTime() + 1000;
    return { changed, fingerprint };
  }

  // No way to tell from the summary; only brand-new conversations are fetched.
  return { changed: false, fingerprint };
}

function emitNewMessage(io, conversation, message) {
  if (!io || !conversation || !message) return;
  try {
    io.emit("new_message", {
      conversationId: conversation._id,
      message,
      conversation: {
        _id: conversation._id,
        platform: conversation.platform,
        customerName: conversation.customerName,
        lastMessage: conversation.lastMessage,
        lastMessageAt: conversation.lastMessageAt,
        unreadCount: conversation.unreadCount,
        status: conversation.status,
      },
    });
  } catch (err) {
    // Socket delivery is best-effort; the data is already saved.
  }
}

/**
 * Fetch one changed conversation's messages and upsert any new ones.
 * @returns {Promise<number>} number of new messages stored
 */
async function syncConversation(account, summary, io, budget) {
  const conversationId = summary.conversationId;

  const before = await Conversation.findOne({ platform: "ebay", platformConversationId: conversationId })
    .select("messages.platformMessageId")
    .lean();
  const knownIds = new Set((before?.messages || []).map((m) => m.platformMessageId));

  const details = await ebayAdapter.client.getConversation(
    account.accessToken,
    conversationId,
    summary.conversationType
  );

  // Oldest → newest, so the Conversation pre-save hook leaves the newest
  // message as lastMessage/lastMessageAt.
  const messages = [...(details?.messages || [])].sort(
    (a, b) => new Date(a?.createdDate || 0).getTime() - new Date(b?.createdDate || 0).getTime()
  );

  let conversation = null;
  for (const msg of messages) {
    conversation = await ebayAdapter._upsertMessage(msg, summary, account);
  }
  if (!conversation) return 0;

  const added = conversation.messages.filter((m) => !knownIds.has(m.platformMessageId));
  if (added.length === 0) return 0;

  // Count new customer messages as unread for the inbox badge. Seller
  // messages (sent from eBay's own UI) are not unread.
  const unreadIncrement = added.filter((m) => m.senderType === "customer").length;
  if (unreadIncrement > 0) {
    await Conversation.updateOne({ _id: conversation._id }, { $inc: { unreadCount: unreadIncrement } });
    conversation.unreadCount = (conversation.unreadCount || 0) + unreadIncrement;
  }

  for (const message of added) {
    if (budget.events >= MAX_EVENTS_PER_RUN) break;
    budget.events += 1;
    emitNewMessage(io, conversation, message);
  }

  return added.length;
}

/**
 * Run one incremental sync pass for the connected eBay account.
 *
 * @param {Object} [options]
 * @param {import("socket.io").Server} [options.io] - for live inbox updates
 * @param {boolean} [options.deepScan] - scan up to MAX_PAGES even when a page has no changes
 * @returns {Promise<Object>} run summary (counts only)
 */
async function syncEbayMessages({ io = null, deepScan = false } = {}) {
  const startedAt = Date.now();
  const result = {
    skipped: null,
    pagesScanned: 0,
    conversationsChecked: 0,
    detailFetches: 0,
    newMessages: 0,
    conversationErrors: 0,
    stoppedEarlyBy: null,
  };

  const account = await IntegrationAccount.findOne({ platform: "ebay", isActive: true }).sort({ createdAt: -1 });
  if (!account || !account.accessToken) {
    result.skipped = "no_active_ebay_account";
    return result;
  }

  if (account.isTokenExpired) {
    if (!account.refreshToken) {
      result.skipped = "token_expired_no_refresh_token";
      return result;
    }
    await ebayAdapter.refreshToken(account);
  }

  const budget = { events: 0 };
  const outOfTime = () => Date.now() - startedAt > TIME_BUDGET_MS;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      if (outOfTime()) {
        result.stoppedEarlyBy = "time_budget";
        break;
      }

      const offset = page * PAGE_SIZE;
      const listing = await ebayAdapter.client.getConversations(account.accessToken, { limit: PAGE_SIZE, offset });
      const summaries = Array.isArray(listing?.conversations) ? listing.conversations : [];
      result.pagesScanned += 1;

      let changedOnPage = 0;
      for (const summary of summaries) {
        if (!summary?.conversationId) continue;
        if (result.detailFetches >= MAX_DETAIL_FETCHES) {
          result.stoppedEarlyBy = "detail_cap";
          break;
        }
        if (outOfTime()) {
          result.stoppedEarlyBy = "time_budget";
          break;
        }

        result.conversationsChecked += 1;
        const { changed, fingerprint } = await hasNewActivity(summary);
        if (!changed) continue;

        changedOnPage += 1;
        result.detailFetches += 1;
        try {
          result.newMessages += await syncConversation(account, summary, io, budget);
        } catch (convErr) {
          // Auth and rate-limit errors affect every call: abort the run so the
          // job backs off. Anything else is specific to this conversation, so
          // skip it rather than let it block every later run.
          if (convErr instanceof EbayAuthError || convErr?.isRateLimited) throw convErr;
          result.conversationErrors += 1;
          console.error(
            `${LOG_PREFIX} Skipping conversation ${summary.conversationId}:`,
            convErr?.message || convErr
          );
        }
        rememberFingerprint(summary.conversationId, fingerprint);
      }

      if (result.stoppedEarlyBy) break;

      const total = Number(listing?.total) || 0;
      const lastPage = summaries.length < PAGE_SIZE || (total > 0 && offset + PAGE_SIZE >= total);
      if (lastPage) break;
      if (changedOnPage === 0 && !deepScan) break;
    }
  } catch (err) {
    // A 401 mid-run means the token went stale; refresh it for the next run
    // (the 15-minute refresh cron would also catch it) and report the failure.
    if (err instanceof EbayAuthError && account.refreshToken) {
      try {
        await ebayAdapter.refreshToken(account);
      } catch (refreshErr) {
        console.error(`${LOG_PREFIX} Token refresh after 401 failed:`, refreshErr.message || refreshErr);
      }
    }
    throw err;
  }

  return result;
}

module.exports = {
  syncEbayMessages,
  // exported for tests
  _hasNewActivity: hasNewActivity,
  _summaryLatest: summaryLatest,
};
