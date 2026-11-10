/**
 * CRM → eBay quantity sync.
 *
 * When stock changes in the CRM for a reason that did NOT happen on eBay
 * (in-store sale, Wix sale, cancellation restore, return restock, manual
 * adjustment), the part is queued here and its CURRENT CRM quantity is
 * pushed to its eBay listing. eBay-originated sales are never queued (eBay
 * already lowered its own quantity) — no update loops.
 *
 *   Inventory API listing (has ebayOfferId) → bulk_update_price_quantity
 *   Trading API listing (eBay Motors)       → ReviseInventoryStatus, or
 *                                             EndFixedPriceItem when 0
 *
 * Queue state lives on Inventory.ebayQuantitySync:
 *   pending → synced | failed (retried with exponential backoff) | dead
 *   (permanent error or MAX_ATTEMPTS reached — visible in the CRM with a Retry
 *   button) | skipped (part has no eBay listing).
 * Several quick changes collapse into one push of the latest quantity.
 *
 * Disable entirely with EBAY_QUANTITY_SYNC_ENABLED=false.
 */
const Inventory = require("../models/Inventory.model");
const IntegrationAccount = require("../models/IntegrationAccount.model");
const realtime = require("../utils/realtime");
const { isAllCronSyncDisabled } = require("../utils/cronSyncSwitch");

const LOG_PREFIX = "[EBAY QUANTITY SYNC]";
const MAX_ATTEMPTS = 8;
const LEASE_MS = 2 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const NOT_CONNECTED_RETRY_MS = 15 * 60 * 1000;

class PermanentSyncError extends Error {}

// Overridable for tests.
const deps = {
  getClient: () => require("./adapters/ebayAdapter").client,
  getTradingClient: () => require("./adapters/ebayAdapter").tradingClient,
  getAccount: async () => {
    const account = await IntegrationAccount.findOne({ platform: "ebay", isActive: true }).sort({ createdAt: -1 });
    if (!account || !account.accessToken) return null;
    if (account.isTokenExpired) {
      if (!account.refreshToken) return null;
      await require("./adapters/ebayAdapter").refreshToken(account);
    }
    return account;
  },
};

const enabled = () => process.env.EBAY_QUANTITY_SYNC_ENABLED !== "false";
const targetQuantity = (part) =>
  part.isDeleted ? 0 : Math.max(0, part.quantityAvailable ?? (part.saleStatus === "sold" ? 0 : 1));
const isOnEbay = (part) => Boolean(part.ebayOfferId || part.ebayListingId);

let timer = null;
function scheduleSoon() {
  // DISABLE_ALL_CRON_SYNC=true: leave the work queued (it is kept in the
  // database) and process it once jobs are switched back on.
  if (timer || isAllCronSyncDisabled() || process.env.EBAY_QUANTITY_SYNC_AUTORUN === "false") return;
  timer = setTimeout(() => {
    timer = null;
    processQueue().catch((err) => console.error(`${LOG_PREFIX} run failed:`, err.message));
  }, 2000);
  if (timer.unref) timer.unref();
}

/** Queue a part's current quantity for eBay. No-op if it has no eBay listing. */
async function enqueue(inventoryId, reason) {
  if (!enabled()) return false;
  const part = await Inventory.findById(inventoryId).select("ebayOfferId ebayListingId").lean();
  if (!part || !isOnEbay(part)) return false;
  const now = new Date();
  await Inventory.updateOne({ _id: inventoryId }, [
    {
      $set: {
        ebayQuantitySync: {
          $mergeObjects: [
            { $ifNull: ["$ebayQuantitySync", {}] },
            { status: "pending", reason, attempts: 0, nextAttemptAt: now, lastError: null, updatedAt: now },
          ],
        },
      },
    },
  ]);
  realtime.invalidate("inventorySync");
  scheduleSoon();
  return true;
}

function tradingErrors(response) {
  const errors = response?.Errors;
  return (Array.isArray(errors) ? errors : errors ? [errors] : []).filter((e) => e?.SeverityCode !== "Warning");
}

async function pushQuantity(part, account) {
  const quantity = targetQuantity(part);

  if (part.ebayOfferId) {
    const sku = part.ebaySku || String(part._id);
    const res = await deps.getClient().post(account.accessToken, "/sell/inventory/v1/bulk_update_price_quantity", {
      requests: [
        {
          sku,
          shipToLocationAvailability: { quantity },
          offers: [{ offerId: part.ebayOfferId, availableQuantity: quantity }],
        },
      ],
    });
    const r = res?.responses?.[0];
    if (r && Number(r.statusCode) >= 400) {
      const msg = (r.errors || []).map((e) => e.message || e.longMessage).filter(Boolean).join("; ");
      throw new PermanentSyncError(`eBay rejected the quantity update (${r.statusCode})${msg ? `: ${msg}` : ""}`);
    }
    return quantity;
  }

  // Trading API listing (eBay Motors categories).
  const trading = deps.getTradingClient();
  const itemId = String(part.ebayListingId).replace(/[^0-9]/g, "");
  if (quantity > 0) {
    const xml = `<?xml version="1.0" encoding="utf-8"?><ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents"><InventoryStatus><ItemID>${itemId}</ItemID><Quantity>${quantity}</Quantity></InventoryStatus></ReviseInventoryStatusRequest>`;
    const res = await trading.call(account.accessToken, "ReviseInventoryStatus", xml);
    const body = res?.ReviseInventoryStatusResponse || res;
    const errs = tradingErrors(body);
    if (body?.Ack === "Failure" || errs.length) {
      throw new PermanentSyncError(`ReviseInventoryStatus failed: ${errs.map((e) => e.LongMessage || e.ShortMessage).join("; ") || "unknown error"}`);
    }
  } else {
    const xml = `<?xml version="1.0" encoding="utf-8"?><EndFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${itemId}</ItemID><EndingReason>NotAvailable</EndingReason></EndFixedPriceItemRequest>`;
    const res = await trading.endFixedPriceItem(account.accessToken, xml);
    const body = res?.EndFixedPriceItemResponse || res;
    // 1047 = auction/listing already closed → the goal (not for sale) is met.
    const errs = tradingErrors(body).filter((e) => String(e.ErrorCode) !== "1047");
    if (errs.length) {
      throw new PermanentSyncError(`EndFixedPriceItem failed: ${errs.map((e) => e.LongMessage || e.ShortMessage).join("; ")}`);
    }
  }
  return quantity;
}

function isTransient(err) {
  if (err instanceof PermanentSyncError) return false;
  const status = err?.statusCode ?? err?.response?.status;
  if (err?.name === "EbayRateLimitError" || err?.name === "EbayAuthError") return true;
  if (!status) return true; // network / timeout
  return status === 429 || status >= 500;
}

async function finish(partId, $set) {
  const set = {};
  for (const [k, v] of Object.entries($set)) set[`ebayQuantitySync.${k}`] = v;
  set["ebayQuantitySync.updatedAt"] = new Date();
  await Inventory.updateOne({ _id: partId }, { $set: set });
}

/**
 * Push queued quantities to eBay. Safe to run concurrently: each part is
 * claimed by moving its nextAttemptAt forward (lease) before the call.
 */
async function processQueue({ limit = 25 } = {}) {
  const summary = { processed: 0, synced: 0, failed: 0, dead: 0, skipped: 0, waiting: 0 };
  if (!enabled()) return { ...summary, disabled: true };

  let account = null;
  let accountChecked = false;

  for (let i = 0; i < limit; i += 1) {
    const now = new Date();
    const part = await Inventory.findOneAndUpdate(
      {
        "ebayQuantitySync.status": { $in: ["pending", "failed"] },
        "ebayQuantitySync.nextAttemptAt": { $lte: now },
      },
      { $set: { "ebayQuantitySync.nextAttemptAt": new Date(now.getTime() + LEASE_MS) } },
      {
        sort: { "ebayQuantitySync.nextAttemptAt": 1 },
        new: true,
        projection: { ebayOfferId: 1, ebayListingId: 1, ebaySku: 1, quantityAvailable: 1, saleStatus: 1, isDeleted: 1, ebayQuantitySync: 1 },
      }
    ).lean();
    if (!part) break;
    summary.processed += 1;

    if (!isOnEbay(part)) {
      await finish(part._id, { status: "skipped", lastError: "Part has no eBay listing" });
      summary.skipped += 1;
      continue;
    }

    if (!accountChecked) {
      accountChecked = true;
      try {
        account = await deps.getAccount();
      } catch (err) {
        console.error(`${LOG_PREFIX} eBay account/token error:`, err.message);
        account = null;
      }
    }
    if (!account) {
      await finish(part._id, {
        lastError: "eBay is not connected or its token expired — will retry",
        nextAttemptAt: new Date(Date.now() + NOT_CONNECTED_RETRY_MS),
      });
      summary.waiting += 1;
      continue;
    }

    const attempts = (part.ebayQuantitySync?.attempts || 0) + 1;
    try {
      const pushed = await pushQuantity(part, account);
      // If stock changed while we were calling eBay, push again.
      const fresh = await Inventory.findById(part._id).select("quantityAvailable saleStatus isDeleted").lean();
      const stillCurrent = fresh && targetQuantity(fresh) === pushed;
      await finish(part._id, {
        status: stillCurrent ? "synced" : "pending",
        syncedQuantity: pushed,
        syncedAt: new Date(),
        attempts: stillCurrent ? attempts : 0,
        nextAttemptAt: new Date(),
        lastError: null,
      });
      summary.synced += 1;
    } catch (err) {
      const transient = isTransient(err);
      const dead = !transient || attempts >= MAX_ATTEMPTS;
      const backoff = Math.min(60 * 1000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
      await finish(part._id, {
        status: dead ? "dead" : "failed",
        attempts,
        lastError: String(err.message || err).slice(0, 500),
        nextAttemptAt: new Date(Date.now() + backoff),
      });
      console.error(`${LOG_PREFIX} part ${part._id} attempt ${attempts} ${dead ? "GAVE UP" : "failed"}:`, err.message);
      if (dead) summary.dead += 1;
      else summary.failed += 1;
    }
  }

  if (summary.processed) realtime.invalidate("inventory", "inventorySync");
  return summary;
}

/** Staff "Retry": put a failed/dead part back in the queue. */
async function retry(inventoryId) {
  const res = await Inventory.updateOne(
    { _id: inventoryId, "ebayQuantitySync.status": { $in: ["failed", "dead", "pending", "skipped"] } },
    {
      $set: {
        "ebayQuantitySync.status": "pending",
        "ebayQuantitySync.attempts": 0,
        "ebayQuantitySync.nextAttemptAt": new Date(),
        "ebayQuantitySync.updatedAt": new Date(),
      },
    }
  );
  if (res.modifiedCount) scheduleSoon();
  return res.modifiedCount > 0;
}

module.exports = { enqueue, processQueue, retry, targetQuantity, _deps: deps, MAX_ATTEMPTS };
