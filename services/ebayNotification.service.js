/**
 * eBay Notification API (webhooks) → durable inbox → order processing.
 *
 * Receive (POST /api/integrations/ebay/notifications):
 *   1. Verify X-EBAY-SIGNATURE (base64 JSON {alg, kid, signature, digest})
 *      with eBay's public key for `kid` (GET commerce/notification/v1/public_key,
 *      application token, cached 1 h). Unverified → rejected, nothing stored.
 *   2. Store the event in MarketplaceEvent (unique notificationId → a
 *      re-delivered notification is stored once) and acknowledge with 204.
 *
 * Process (worker, jobs/inventorySyncWorkerJob.js):
 *   ORDER_CONFIRMATION → fetch the AUTHORITATIVE order from the Fulfillment
 *   API (never trust the payload alone) → the existing order path
 *   (ebayAdapter._upsertOrder → Orders page + marketplaceSales.applyEbayOrder →
 *   ledger). Delayed, duplicated or out-of-order notifications are harmless:
 *   the current order state is read and stock changes are keyed per order line.
 *   Failures retry with exponential backoff; after MAX_ATTEMPTS → "dead"
 *   (visible in the CRM with a Retry button). Other topics → "ignored".
 *
 * Destination verification (GET with challenge_code) uses
 * EBAY_NOTIFICATION_ENDPOINT_URL + EBAY_NOTIFICATION_VERIFICATION_TOKEN,
 * same scheme as the existing Marketplace Account Deletion endpoint.
 */
const crypto = require("crypto");
const axios = require("axios");
const MarketplaceEvent = require("../models/MarketplaceEvent.model");
const IntegrationAccount = require("../models/IntegrationAccount.model");
const realtime = require("../utils/realtime");

const LOG_PREFIX = "[EBAY NOTIFICATION]";
const MAX_ATTEMPTS = 8;
const LEASE_MS = 3 * 60 * 1000;
const KEY_CACHE_MS = 60 * 60 * 1000;
const HANDLED_TOPICS = new Set(["ORDER_CONFIRMATION"]);

class SignatureError extends Error {}

// Overridable for tests.
const deps = {
  getAdapter: () => require("./adapters/ebayAdapter"),
  fetchPublicKey: null, // (kid) => {key, digest} — default below
  getAccount: async () => {
    const account = await IntegrationAccount.findOne({ platform: "ebay", isActive: true }).sort({ createdAt: -1 });
    if (!account || !account.accessToken) return null;
    if (account.isTokenExpired) {
      if (!account.refreshToken) return null;
      await deps.getAdapter().refreshToken(account);
    }
    return account;
  },
};

// ─── application token + public keys ────────────────────────────────────────

let appToken = null;
async function getApplicationToken() {
  if (appToken && appToken.expiresAt > Date.now() + 60000) return appToken.value;
  const client = deps.getAdapter().client;
  const basic = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString("base64");
  const res = await axios.post(
    `${client.getBaseUrl()}/identity/v1/oauth2/token`,
    new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` }, timeout: 15000 }
  );
  appToken = { value: res.data.access_token, expiresAt: Date.now() + (res.data.expires_in || 7200) * 1000 };
  return appToken.value;
}

const keyCache = new Map();
async function defaultFetchPublicKey(kid) {
  const token = await getApplicationToken();
  const client = deps.getAdapter().client;
  const res = await axios.get(`${client.getBaseUrl()}/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
  return { key: res.data.key, digest: res.data.digest || "SHA1" };
}

async function getPublicKey(kid) {
  const hit = keyCache.get(kid);
  if (hit && hit.expiresAt > Date.now()) return hit;
  const fetched = await (deps.fetchPublicKey || defaultFetchPublicKey)(kid);
  const entry = { ...fetched, expiresAt: Date.now() + KEY_CACHE_MS };
  keyCache.set(kid, entry);
  return entry;
}

/** eBay returns the PEM on one line; Node needs the header/footer on their own lines. */
function toPem(key) {
  const k = String(key || "").trim();
  if (k.includes("\n")) return k;
  return k
    .replace("-----BEGIN PUBLIC KEY-----", "-----BEGIN PUBLIC KEY-----\n")
    .replace("-----END PUBLIC KEY-----", "\n-----END PUBLIC KEY-----");
}

/**
 * Verify the X-EBAY-SIGNATURE header against the message body.
 * @throws {SignatureError}
 */
async function verifySignature(signatureHeader, rawBody, parsedBody) {
  if (!signatureHeader) throw new SignatureError("missing X-EBAY-SIGNATURE header");
  let sig;
  try {
    sig = JSON.parse(Buffer.from(String(signatureHeader), "base64").toString("utf8"));
  } catch (_) {
    throw new SignatureError("unreadable X-EBAY-SIGNATURE header");
  }
  if (!sig?.kid || !sig?.signature) throw new SignatureError("X-EBAY-SIGNATURE has no kid/signature");

  const { key, digest } = await getPublicKey(sig.kid);
  const algorithm = String(sig.digest || digest || "SHA1").toLowerCase().replace("-", "");
  const pem = toPem(key);
  const candidates = [];
  if (rawBody && rawBody.length) candidates.push(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody)));
  if (parsedBody) candidates.push(Buffer.from(JSON.stringify(parsedBody)));

  for (const body of candidates) {
    const verifier = crypto.createVerify(algorithm);
    verifier.update(body);
    if (verifier.verify(pem, sig.signature, "base64")) return true;
  }
  throw new SignatureError("signature does not match");
}

// ─── receive ────────────────────────────────────────────────────────────────

/**
 * Verify + store one webhook delivery.
 * @returns {Promise<{status: number, stored?: boolean, duplicate?: boolean, error?: string}>}
 */
async function receive({ signature, rawBody, body }) {
  try {
    await verifySignature(signature, rawBody, body);
  } catch (err) {
    if (err instanceof SignatureError) {
      console.warn(`${LOG_PREFIX} rejected unverified delivery: ${err.message}`);
      return { status: 412, error: err.message };
    }
    // Couldn't reach eBay for the key: ask eBay to redeliver later.
    console.error(`${LOG_PREFIX} verification unavailable:`, err.message);
    return { status: 500, error: "verification temporarily unavailable" };
  }

  const topic = body?.metadata?.topic;
  const notification = body?.notification || {};
  const eventId = notification.notificationId;
  if (!topic || !eventId) return { status: 400, error: "payload has no metadata.topic / notification.notificationId" };

  const data = notification.data || {};
  const orderId = data.order?.orderId || data.orderId || null;
  try {
    await MarketplaceEvent.create({
      channel: "ebay",
      eventId: String(eventId),
      topic: String(topic),
      orderId: orderId ? String(orderId) : null,
      payload: body,
      status: HANDLED_TOPICS.has(topic) ? "received" : "ignored",
    });
  } catch (err) {
    if (err && err.code === 11000) return { status: 204, duplicate: true };
    console.error(`${LOG_PREFIX} could not store event ${eventId}:`, err.message);
    return { status: 500, error: "could not store event" }; // eBay will retry
  }
  realtime.invalidate("inventorySync");
  scheduleSoon();
  return { status: 204, stored: true };
}

// ─── process ────────────────────────────────────────────────────────────────

async function processOne(event) {
  if (event.topic !== "ORDER_CONFIRMATION") return { status: "ignored" };
  if (!event.orderId) throw new Error("ORDER_CONFIRMATION without orderId");

  const account = await deps.getAccount();
  if (!account) throw new Error("eBay is not connected or its token expired");

  const adapter = deps.getAdapter();
  // Authoritative order details — never the webhook payload alone.
  const order = await adapter.client.get(
    account.accessToken,
    `/sell/fulfillment/v1/order/${encodeURIComponent(event.orderId)}`
  );
  if (!order?.orderId) throw new Error(`eBay returned no order for ${event.orderId}`);

  // Same path as "Sync Orders": saves the CRM Order and applies stock (ledger).
  const saved = await adapter._upsertOrder(order, account);
  const r = saved?.$locals?.saleResult || {};
  return {
    status: "done",
    result: {
      sold: r.sold || 0,
      refreshed: r.refreshed || 0,
      released: r.released || 0,
      conflicts: r.conflicts || 0,
      unmatched: r.unmatched || [],
    },
  };
}

/** Process due events. Safe to run concurrently (each event is leased). */
async function processEvents({ limit = 20 } = {}) {
  const summary = { processed: 0, done: 0, failed: 0, dead: 0, ignored: 0 };
  for (let i = 0; i < limit; i += 1) {
    const now = new Date();
    const event = await MarketplaceEvent.findOneAndUpdate(
      {
        $or: [
          { status: { $in: ["received", "failed"] }, nextAttemptAt: { $lte: now } },
          { status: "processing", leaseUntil: { $lte: now } }, // crashed mid-run
        ],
      },
      { $set: { status: "processing", leaseUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, new: true }
    );
    if (!event) break;
    summary.processed += 1;

    try {
      const out = await processOne(event);
      await MarketplaceEvent.updateOne(
        { _id: event._id },
        { $set: { status: out.status, result: out.result || null, lastError: null, processedAt: new Date(), leaseUntil: null } }
      );
      summary[out.status] = (summary[out.status] || 0) + 1;
    } catch (err) {
      const dead = event.attempts >= MAX_ATTEMPTS;
      const backoff = Math.min(60 * 1000 * 2 ** (event.attempts - 1), 6 * 60 * 60 * 1000);
      await MarketplaceEvent.updateOne(
        { _id: event._id },
        {
          $set: {
            status: dead ? "dead" : "failed",
            lastError: String(err.message || err).slice(0, 500),
            nextAttemptAt: new Date(Date.now() + backoff),
            leaseUntil: null,
          },
        }
      );
      console.error(`${LOG_PREFIX} event ${event.eventId} attempt ${event.attempts} ${dead ? "GAVE UP" : "failed"}:`, err.message);
      summary[dead ? "dead" : "failed"] += 1;
    }
  }
  if (summary.processed) realtime.invalidate("inventorySync", "soldProducts", "inventory");
  return summary;
}

/** Staff "Retry" for a failed/dead event. */
async function retryEvent(id) {
  const res = await MarketplaceEvent.updateOne(
    { _id: id, status: { $in: ["failed", "dead"] } },
    { $set: { status: "received", attempts: 0, nextAttemptAt: new Date(), lastError: null } }
  );
  if (res.modifiedCount) scheduleSoon();
  return res.modifiedCount > 0;
}

let timer = null;
function scheduleSoon() {
  if (timer || process.env.EBAY_NOTIFICATION_AUTORUN === "false") return;
  timer = setTimeout(() => {
    timer = null;
    processEvents().catch((err) => console.error(`${LOG_PREFIX} run failed:`, err.message));
  }, 500);
  if (timer.unref) timer.unref();
}

/** Destination verification: SHA-256(challengeCode + verificationToken + endpoint). */
function challengeResponse(challengeCode) {
  const endpoint = process.env.EBAY_NOTIFICATION_ENDPOINT_URL;
  const token = process.env.EBAY_NOTIFICATION_VERIFICATION_TOKEN;
  if (!endpoint || !token) return null;
  return crypto.createHash("sha256").update(challengeCode).update(token).update(endpoint).digest("hex");
}

module.exports = {
  receive,
  processEvents,
  retryEvent,
  verifySignature,
  challengeResponse,
  SignatureError,
  _deps: deps,
  _keyCache: keyCache,
  MAX_ATTEMPTS,
};
