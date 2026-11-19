/**
 * eBay Active Listing Reconciliation Service
 *
 * Single authoritative engine for the eBay → CRM Marketplace Listing
 * direction. It is the ONLY place that fetches the seller's currently ACTIVE
 * eBay listings and reconciles them into the MarketplaceListing collection.
 *
 * WHY THIS EXISTS
 * ---------------
 * The previous eBay listing pull read the Inventory API's
 * GET /sell/inventory/v1/inventory_item endpoint. That endpoint returns every
 * inventory record the seller has ever stored — including items that were
 * never published and items whose offer has been withdrawn. It cannot answer
 * "is this listing active?", so inactive/stale records were imported and then
 * never removed, and the Inventory API's `total` was also driving pagination
 * for an unrelated Trading-API feed that was hardcoded to page 1 / 200 items.
 *
 * This service instead uses:
 *   - Trading API GetMyeBaySelling ActiveList — eBay's own "these are active"
 *     container — paged fully via eBay's reported TotalNumberOfPages; and
 *   - Inventory API GET /offer?sku= ONLY to refine price/quantity/state for
 *     the specific active items that need it (never to decide activeness).
 *
 * SAFETY MODEL (Requirement 20)
 * -----------------------------
 * Destructive reconciliation (removing CRM records that are not in the active
 * set) happens ONLY when ALL of the following hold:
 *   1. Every page of the active-listing fetch completed without error;
 *   2. eBay reported an Ack of Success/Warning for every page;
 *   3. The fetch did not hit the internal page safety cap; and
 *   4. The fetched active set is non-empty, OR eBay itself confirmed that the
 *      seller has zero active listings (see isConfirmedEmptyStore below).
 * If any of those fail, the fetch is marked incomplete and NO record is
 * removed — a partial fetch must never be interpreted as "the rest ended".
 *
 * Rule 4 used to require a non-empty set unconditionally. That meant a seller
 * who ended EVERY listing on eBay could never have the CRM rows cleaned up.
 * An empty result is now trusted only when eBay answered Ack=Success on a
 * single, error-free page and either reported TotalNumberOfEntries=0 or left
 * out the ActiveList container. A failed or partial call never meets that.
 *
 * Transient page failures (timeouts, network resets, HTTP 429/5xx) are
 * retried before the fetch is declared incomplete. Without retries, a single
 * slow GetMyeBaySelling page skipped stale removal for the whole run.
 *
 * This module is eBay-only. Nothing here touches Amazon, Wix, Clover, TikTok,
 * Meta, Google Ads, inventory, or the CRM → eBay catalog push pipeline
 * (services/ebay/ebayCatalogSync.service.js), which is left untouched.
 */
const MarketplaceListing = require("../../models/MarketplaceListing.model");
const IntegrationAccount = require("../../models/IntegrationAccount.model");
const platformManager = require("../platformManager.service");
const { EbayApiClient } = require("../clients/ebayApiClient");
const EbayTradingClient = require("../clients/ebayTradingClient");

const client = new EbayApiClient();
const tradingClient = new EbayTradingClient();

/** eBay's documented maximum for GetMyeBaySelling EntriesPerPage. */
const DEFAULT_PAGE_SIZE = 200;

/**
 * Hard stop on pagination. Acts as a runaway guard, not a business limit: if
 * eBay ever reports a nonsensical TotalNumberOfPages, we must not loop
 * forever. Reaching this marks the fetch INCOMPLETE (so nothing is removed).
 */
const MAX_SAFETY_PAGES = 500;

function positiveIntFromEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Timeout for one GetMyeBaySelling page. A 200-item ActiveList page is a
 * large response and regularly took longer than the client's 30s default,
 * which made every run "incomplete".
 */
const PAGE_TIMEOUT_MS = positiveIntFromEnv("EBAY_RECONCILE_PAGE_TIMEOUT_MS", 90000);

/** Total attempts per page (first try + retries) for transient failures. */
const PAGE_MAX_ATTEMPTS = positiveIntFromEnv("EBAY_RECONCILE_PAGE_ATTEMPTS", 3);

/** Base back-off between attempts; grows linearly (5s, 10s, ...). */
const PAGE_RETRY_BASE_DELAY_MS = 5000;

const LOG_PREFIX = "[EBAY SYNC]";

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function warn(...args) {
  console.warn(LOG_PREFIX, ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True for failures worth retrying: timeouts, dropped connections, eBay
 * rate limiting (429) and eBay server errors (5xx). Auth failures and other
 * 4xx responses are not retried, because the same request would fail again.
 */
function isTransientEbayError(err) {
  const status = err?.response?.status;
  if (status === 429 || (Number.isFinite(status) && status >= 500)) return true;
  if (status) return false;
  const code = String(err?.code || "");
  if (["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "ERR_NETWORK"].includes(code)) {
    return true;
  }
  return /timeout|socket hang up|network/i.test(String(err?.message || ""));
}

/**
 * Fetch one ActiveList page, retrying transient failures with back-off.
 * Rethrows the last error when every attempt fails or the error is not
 * transient, so the caller still marks the fetch incomplete.
 */
async function fetchActiveListingsPageWithRetry(accessToken, page, pageSize) {
  let lastErr;
  for (let attempt = 1; attempt <= PAGE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await tradingClient.getActiveListingsPage(accessToken, page, pageSize, {
        timeout: PAGE_TIMEOUT_MS,
      });
    } catch (err) {
      lastErr = err;
      if (attempt >= PAGE_MAX_ATTEMPTS || !isTransientEbayError(err)) break;
      const delay = PAGE_RETRY_BASE_DELAY_MS * attempt;
      warn(
        `GetMyeBaySelling page ${page} attempt ${attempt}/${PAGE_MAX_ATTEMPTS} failed (${err.message || err}) — retrying in ${delay}ms`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Resolve the connected eBay seller account.
 *
 * Reuses the existing integration architecture: exactly one active eBay
 * IntegrationAccount is expected (the same assumption
 * services/ebay/ebayCatalogSync.service.js and controllers/
 * marketplaceListing.controller.js already make). The resolved account's
 * identity is what scopes every record written or removed, so two connected
 * eBay accounts can never mix.
 *
 * @returns {Promise<Object>} the IntegrationAccount document
 * @throws {Error} with code EBAY_ACCOUNT_NOT_CONNECTED when none is active
 */
async function resolveActiveEbayAccount() {
  const account = await IntegrationAccount.findOne({
    platform: "ebay",
    isActive: true,
  }).sort({ createdAt: -1 });

  if (!account) {
    const err = new Error(
      "No active eBay integration found. Connect eBay in Platform Connections first."
    );
    err.code = "EBAY_ACCOUNT_NOT_CONNECTED";
    err.statusCode = 404;
    throw err;
  }

  return account;
}

/**
 * Stable, human-readable key identifying the connected eBay seller account.
 *
 * Prefers platformUserId (eBay's own account identity, already uniquely
 * indexed per platform) and falls back to the IntegrationAccount _id so a
 * record is ALWAYS attributed to exactly one account.
 *
 * @param {Object} account
 * @returns {string}
 */
function buildEbayAccountKey(account) {
  const identity =
    account?.platformUserId || account?.platformName || account?.platformEmail || null;
  return identity ? `ebay:${String(identity)}` : `ebay:${String(account?._id || "unknown")}`;
}

/**
 * Ensure a usable access token, reusing the existing OAuth refresh
 * implementation on the eBay adapter (never a second OAuth system).
 *
 * A refresh failure propagates as a controlled error; the caller aborts
 * BEFORE any reconciliation, so a token problem can never cause removals.
 *
 * @param {Object} account
 * @returns {Promise<string>} access token
 */
async function ensureFreshEbayAccessToken(account) {
  if (account.isTokenExpired && account.refreshToken) {
    log("Access token expired — refreshing via existing eBay adapter refreshToken()");
    const adapter = platformManager.getAdapter("ebay");
    if (!adapter || typeof adapter.refreshToken !== "function") {
      const err = new Error(
        "eBay authentication expired and the eBay adapter is unavailable to refresh it. Please reconnect the eBay account."
      );
      err.code = "EBAY_AUTH_UNAVAILABLE";
      err.statusCode = 401;
      throw err;
    }
    await adapter.refreshToken(account);
  }

  if (!account.accessToken) {
    const err = new Error(
      "eBay authentication expired or invalid. Please reconnect the eBay account."
    );
    err.code = "EBAY_AUTH_INVALID";
    err.statusCode = 401;
    throw err;
  }

  return account.accessToken;
}

/**
 * Map real eBay listing/offer state into the CRM's canonical vocabulary.
 *
 * Never returns "Unknown". This function is only ever invoked for items the
 * ACTIVE listings feed returned, so the absence of any finer-grained signal
 * means "active" — that is a verified fact of the data source, not a
 * hardcoded assumption. "Out of Stock" is only used for a genuinely reported
 * quantity of exactly 0 (a null/absent quantity is NOT zero).
 *
 * @param {Object} params
 * @param {string|null} [params.rawListingStatus] - Trading ListingStatusCodeType
 * @param {string|null} [params.rawOfferStatus] - Inventory Offer status
 * @param {number|null} [params.quantity]
 * @returns {string} Active | Out of Stock | Inactive | Ended
 */
function normalizeEbayListingStatus({ rawListingStatus, rawOfferStatus, quantity } = {}) {
  const offer = rawOfferStatus == null ? null : String(rawOfferStatus).toUpperCase();
  const listing = rawListingStatus == null ? null : String(rawListingStatus).toUpperCase();
  const zeroQty = quantity === 0;

  // An Inventory offer that is explicitly withdrawn is not a live listing,
  // even though the seller's inventory record still exists.
  if (offer === "UNPUBLISHED") return "Inactive";
  if (offer === "PUBLISHED") return zeroQty ? "Out of Stock" : "Active";

  if (listing === "ACTIVE") return zeroQty ? "Out of Stock" : "Active";
  if (listing === "ENDED" || listing === "COMPLETED") return "Ended";

  // No finer signal available, but eBay's ActiveList itself already asserted
  // this item is active.
  return zeroQty ? "Out of Stock" : "Active";
}

/**
 * Read the Inventory API Offer state for one SKU.
 *
 * Best-effort by design: the inventory item might have no offer at all, or
 * the lookup may fail. Either way the caller keeps the ActiveList-derived
 * status/price rather than losing the listing. The access token is never
 * logged or returned.
 *
 * @returns {Promise<{status: string|null, price: number|null, currency: string|null}>}
 */
async function fetchOfferState(accessToken, sku) {
  const result = { status: null, price: null, currency: null };
  if (!accessToken || !sku) return result;

  try {
    const offersResult = await client.getOffers(accessToken, sku);
    const offer = offersResult?.offers?.[0];
    if (!offer) return result;

    result.status = offer.status || null;

    const offerPrice = offer.pricingSummary?.price;
    if (offerPrice?.value != null) {
      const num = Number(offerPrice.value);
      if (Number.isFinite(num)) {
        result.price = num;
        result.currency = offerPrice.currency || null;
      }
    }
  } catch (err) {
    // Non-fatal: the item came from the ACTIVE feed, so it stays reconciled
    // either way. Logged (message only — never the token).
    warn(`Offer lookup failed for SKU=${sku} (non-fatal):`, err.message || err);
  }

  return result;
}

/**
 * Render eBay's Errors container as a short suffix for a run's error message,
 * e.g. ": [932] Auth token is hard expired.". Bounded so a verbose response
 * can never bloat the stored run document.
 */
function describeTradingErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return "";
  const parts = errors.slice(0, 3).map((e) => {
    const text = e.longMessage || e.shortMessage || "Unknown eBay error";
    return e.code ? `[${e.code}] ${text}` : text;
  });
  return `: ${parts.join(" | ")}`.slice(0, 500);
}

/**
 * Fetch EVERY currently active eBay listing, page by page.
 *
 * @param {string} accessToken
 * @param {Object} [options]
 * @param {number} [options.pageSize]
 * @returns {Promise<{
 *   items: Array<Object>,
 *   totalEntries: number,
 *   totalPages: number,
 *   complete: boolean,
 *   error: string|null,
 *   pagesFetched: number
 * }>}
 */
async function fetchAllActiveEbayListings(accessToken, options = {}) {
  const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;

  const items = [];
  const seenItemIds = new Set();

  let page = 1;
  let totalPages = 1;
  let totalEntries = 0;
  let complete = true;
  let error = null;
  let pagesFetched = 0;
  // What eBay said on page 1; used only to recognise a genuinely empty store.
  let firstPage = null;

  log("Starting active listing reconciliation");

  while (true) {
    log(`Fetching page ${page}${page === 1 ? "" : ` of ${totalPages}`}`);

    let pageResult;
    try {
      pageResult = await fetchActiveListingsPageWithRetry(accessToken, page, pageSize);
    } catch (err) {
      complete = false;
      error = `GetMyeBaySelling page ${page} failed: ${err.message || err}`;
      warn(error);
      break;
    }

    pagesFetched += 1;
    if (page === 1) {
      firstPage = {
        ack: pageResult.ack,
        errorCount: Array.isArray(pageResult.errors) ? pageResult.errors.length : 0,
        itemCount: Array.isArray(pageResult.items) ? pageResult.items.length : 0,
        reportedTotalEntries:
          pageResult.reportedTotalEntries === undefined ? null : pageResult.reportedTotalEntries,
        activeListPresent: pageResult.activeListPresent !== false,
      };
    }

    // eBay reported a protocol-level failure on this page.
    if (pageResult.ack && !/^(success|warning)$/i.test(pageResult.ack)) {
      complete = false;
      error = `GetMyeBaySelling page ${page} returned Ack=${pageResult.ack}${describeTradingErrors(pageResult.errors)}`;
      warn(error);
      break;
    }

    if (Number.isFinite(pageResult.totalPages) && pageResult.totalPages > 0) {
      totalPages = pageResult.totalPages;
    }
    if (Number.isFinite(pageResult.totalEntries) && pageResult.totalEntries > 0) {
      totalEntries = pageResult.totalEntries;
    }

    for (const rawItem of pageResult.items) {
      const itemId = EbayTradingClient.extractItemId(rawItem);
      if (!itemId) continue; // counted as invalid identity by the caller
      if (seenItemIds.has(itemId)) continue; // same item across page boundaries
      seenItemIds.add(itemId);
      items.push(rawItem);
    }

    if (page >= totalPages) break;

    if (page >= MAX_SAFETY_PAGES) {
      complete = false;
      error = `Pagination safety cap (${MAX_SAFETY_PAGES} pages) reached before eBay's TotalNumberOfPages (${totalPages})`;
      warn(error);
      break;
    }

    page += 1;
  }

  if (complete) {
    log(`Total active listings fetched: ${items.length} (eBay reports ${totalEntries})`);
  } else {
    warn(`Active listing fetch INCOMPLETE after ${pagesFetched} page(s): ${error}`);
  }

  const confirmedEmpty = isConfirmedEmptyStore({ complete, pagesFetched, items, firstPage });
  if (confirmedEmpty) {
    log("eBay confirmed the seller has ZERO active listings (Ack=Success, no ActiveList entries)");
  }

  return { items, totalEntries, totalPages, complete, error, pagesFetched, confirmedEmpty };
}

/**
 * Did eBay itself confirm that the seller has no active listings?
 *
 * Deliberately strict, because a "yes" lets the reconciler remove every eBay
 * row for this account. All of these must hold:
 *   - the fetch completed (no thrown error, no failure Ack, no page cap);
 *   - exactly one page was read and it held no items at all (raw items, so
 *     items eBay returned without an ItemID still count as "not empty");
 *   - page 1 answered Ack=Success with no error entries (a Warning is not
 *     trusted for this case);
 *   - eBay either reported TotalNumberOfEntries=0 or left out ActiveList,
 *     which is how GetMyeBaySelling answers when nothing is active.
 *
 * @returns {boolean}
 */
function isConfirmedEmptyStore({ complete, pagesFetched, items, firstPage }) {
  if (!complete || pagesFetched !== 1 || !firstPage) return false;
  if (Array.isArray(items) && items.length > 0) return false;
  if (firstPage.itemCount !== 0) return false;
  if (!/^success$/i.test(String(firstPage.ack || ""))) return false;
  if (firstPage.errorCount > 0) return false;
  if (firstPage.reportedTotalEntries === 0) return true;
  if (!firstPage.activeListPresent && firstPage.reportedTotalEntries === null) return true;
  return false;
}

/**
 * Build the CRM field set for one active eBay listing.
 *
 * Identity is the real eBay ItemID (never the SKU). The SKU is preserved
 * separately as productSku, matching how the CRM → eBay pipeline already
 * stores ebaySku/ebayListingId on Inventory.
 *
 * @returns {Promise<Object|null>} null when the item has no usable identity
 */
async function buildListingFieldsFromTradingItem(rawItem, context) {
  const { accountKey, accessToken } = context;

  const itemId = EbayTradingClient.extractItemId(rawItem);
  if (!itemId) return null;

  const sku = EbayTradingClient.extractSku(rawItem);
  const title = EbayTradingClient.extractTitle(rawItem);

  let price = EbayTradingClient.extractPrice(rawItem);
  let currency = EbayTradingClient.extractCurrency(rawItem);

  // null (not 0) when eBay simply did not report a quantity, so a missing
  // value can never be misread as "genuinely out of stock".
  const rawQuantity = rawItem?.QuantityAvailable ?? rawItem?.Quantity;
  let quantity =
    rawQuantity === undefined || rawQuantity === null || rawQuantity === ""
      ? null
      : Number(rawQuantity);
  if (!Number.isFinite(quantity)) quantity = null;

  const rawListingStatus = EbayTradingClient.extractListingStatus(rawItem);
  let rawOfferStatus = null;

  // ActiveList Omits price/quantity for some listing shapes, and the
  // Inventory Offer is what carries a withdrawal signal. Query it only when
  // it can actually add information for THIS active item.
  if (sku && (price === 0 || quantity === null)) {
    const offerState = await fetchOfferState(accessToken, sku);
    if (offerState.status) rawOfferStatus = offerState.status;
    if (offerState.price != null && (price === 0 || price == null)) {
      price = offerState.price;
      currency = offerState.currency || currency;
    }
  }

  return {
    marketplace: "ebay",
    marketplaceAccountId: accountKey,
    marketplaceListingId: itemId,
    productSku: sku,
    productName: title || itemId,
    quantity: quantity === null ? 1 : quantity,
    price: Number.isFinite(price) ? price : 0,
    currency: currency || "USD",
    listingStatus: normalizeEbayListingStatus({ rawListingStatus, rawOfferStatus, quantity }),
    source: "eBay Active Listing Sync",
  };
}

/** True when two listing field sets are meaningfully different. */
function listingFieldsDiffer(existing, next) {
  if (existing.quantity !== next.quantity) return true;
  if (existing.price !== next.price) return true;
  if (String(existing.marketplaceListingId || "") !== String(next.marketplaceListingId || "")) return true;
  if (String(existing.productSku || "") !== String(next.productSku || "")) return true;
  if (String(existing.productName || "") !== String(next.productName || "")) return true;
  if (String(existing.listingStatus || "") !== String(next.listingStatus || "")) return true;
  if (String(existing.currency || "") !== String(next.currency || "")) return true;
  if (String(existing.marketplaceAccountId || "") !== String(next.marketplaceAccountId || "")) return true;
  return false;
}

/**
 * Reconcile the connected eBay account's ACTIVE listings into the CRM
 * Marketplace Listing collection.
 *
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false] - compute the plan without writing
 * @param {number} [options.pageSize] - GetMyeBaySelling page size (max 200)
 * @param {Object} [options.account] - pre-resolved IntegrationAccount
 * @returns {Promise<Object>} reconciliation summary
 */
async function reconcileEbayListings(options = {}) {
  const startedAt = Date.now();
  const dryRun = Boolean(options.dryRun);

  const account = options.account || (await resolveActiveEbayAccount());
  const accountKey = buildEbayAccountKey(account);

  const accessToken = await ensureFreshEbayAccessToken(account);

  const fetchResult = await fetchAllActiveEbayListings(accessToken, {
    pageSize: options.pageSize,
  });

  // ── Build the complete active field set ────────────────────────────────
  const activeListings = [];
  let invalidIdentityCount = 0;

  for (const rawItem of fetchResult.items) {
    const fields = await buildListingFieldsFromTradingItem(rawItem, { accountKey, accessToken });
    if (!fields) {
      invalidIdentityCount += 1;
      continue;
    }
    activeListings.push(fields);
  }

  const activeIds = activeListings.map((l) => l.marketplaceListingId);

  // ── Load the CRM records that correspond to the active set ─────────────
  // Bounded by the active listing count, so memory stays proportional to the
  // live catalogue rather than the whole historical collection.
  const existingActiveDocs = activeIds.length
    ? await MarketplaceListing.find({
        marketplace: "ebay",
        marketplaceListingId: { $in: activeIds },
      })
        .select(
          "_id marketplaceAccountId marketplaceListingId productSku productName quantity price currency listingStatus"
        )
        .lean()
    : [];

  const byListingId = new Map();
  for (const doc of existingActiveDocs) {
    const key = String(doc.marketplaceListingId);
    if (!byListingId.has(key)) byListingId.set(key, []);
    byListingId.get(key).push(doc);
  }

  const upsertOps = [];
  const duplicateIdSweep = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let duplicatesCollapsed = 0;

  for (const next of activeListings) {
    const candidates = byListingId.get(String(next.marketplaceListingId)) || [];

    // Prefer the record already attributed to this account; otherwise the
    // oldest (stable) record becomes canonical and is migrated onto this
    // account, which is what repairs legacy SKU-keyed/account-less rows.
    let canonical = candidates.find(
      (doc) => String(doc.marketplaceAccountId || "") === String(accountKey)
    );
    if (!canonical && candidates.length) {
      canonical = candidates
        .slice()
        .sort((a, b) => String(a._id).localeCompare(String(b._id)))[0];
    }

    if (!canonical) {
      created += 1;
      upsertOps.push({
        updateOne: {
          filter: {
            marketplace: "ebay",
            marketplaceAccountId: accountKey,
            marketplaceListingId: next.marketplaceListingId,
          },
          update: { $set: next },
          upsert: true,
        },
      });
      continue;
    }

    // Any ADDITIONAL record for the same item id is a duplicate — fold it
    // away rather than leaving two rows for one eBay listing. This is also
    // what collapses the legacy SKU-keyed / account-less rows once the
    // canonical record has been chosen.
    for (const doc of candidates) {
      if (String(doc._id) !== String(canonical._id)) {
        duplicatesCollapsed += 1;
        duplicateIdSweep.push(doc._id);
      }
    }

    if (listingFieldsDiffer(canonical, next)) {
      updated += 1;
      // Update the canonical record BY _id, not by the account-scoped filter.
      // A legacy record carries no marketplaceAccountId, so an account-scoped
      // filter would fail to match it and the upsert would silently INSERT a
      // second row for the same eBay listing. Targeting _id migrates that
      // existing row onto this account in place.
      upsertOps.push({
        updateOne: {
          filter: { _id: canonical._id },
          update: { $set: next },
          upsert: false,
        },
      });
    } else {
      unchanged += 1;
    }
  }

  // ── Stale detection (ONLY when the fetch is provably complete) ─────────
  const fetchIsComplete = fetchResult.complete;
  // eBay confirmed zero active listings: an empty active set is then the
  // truth, not a symptom of a failed call, so every eBay row for this
  // account is stale.
  const ebayConfirmedEmpty = Boolean(fetchResult.confirmedEmpty);
  const hasUsableActiveSet = activeListings.length > 0 || ebayConfirmedEmpty;
  const mayRemoveStale = !dryRun && fetchIsComplete && hasUsableActiveSet;

  let removalsPlanned = 0;
  let removed = 0;
  let staleIds = [];
  let staleScope = null;

  if (!fetchIsComplete) {
    warn(
      `Fetch incomplete (${fetchResult.error || "unknown reason"}) — skipping stale-record removal; no CRM listing will be deleted.`
    );
  } else if (!hasUsableActiveSet) {
    warn(
      "Active listing fetch returned ZERO listings but eBay did not confirm an empty store — refusing stale-record removal to avoid wiping the CRM listing set."
    );
  } else {
    if (ebayConfirmedEmpty) {
      warn("eBay confirmed zero active listings — every CRM eBay listing row for this account will be treated as stale.");
    }
    // Scope: this account's eBay listing rows PLUS legacy eBay listing rows
    // that were written before account scoping existed (no account id).
    // Order-shaped records are excluded by requiring a non-null listing id.
    staleScope = {
      marketplace: "ebay",
      marketplaceListingId: { $ne: null, $nin: activeIds },
      $or: [
        { marketplaceAccountId: accountKey },
        { marketplaceAccountId: { $exists: false } },
        { marketplaceAccountId: null },
      ],
    };

    const staleDocs = await MarketplaceListing.find(staleScope).select("_id").lean();
    staleIds = staleDocs.map((d) => d._id);
    removalsPlanned = staleIds.length;
  }

  if (!dryRun) {
    if (upsertOps.length) {
      const result = await MarketplaceListing.bulkWrite(upsertOps, { ordered: false });
      log(
        `Upsert applied: upserted=${result.upsertedCount || 0} matched=${result.matchedCount || 0} modified=${result.modifiedCount || 0}`
      );
    }

    if (duplicateIdSweep.length) {
      const dupResult = await MarketplaceListing.deleteMany({ _id: { $in: duplicateIdSweep } });
      log(`Collapsed ${dupResult.deletedCount} duplicate eBay listing record(s)`);
    }

    if (mayRemoveStale && staleIds.length) {
      const removeResult = await MarketplaceListing.deleteMany({ _id: { $in: staleIds } });
      removed = removeResult.deletedCount || 0;
      log(`Removed ${removed} stale eBay listing record(s) no longer active on eBay`);
    }
  }

  const summary = {
    success: true,
    marketplace: "ebay",
    dryRun,
    accountKey,
    activeOnEbay: activeListings.length,
    ebayReportedTotal: fetchResult.totalEntries,
    pagesFetched: fetchResult.pagesFetched,
    fetchComplete: fetchIsComplete,
    fetchError: fetchResult.error,
    ebayConfirmedEmpty,
    created,
    updated,
    unchanged,
    duplicatesCollapsed,
    removed: dryRun ? removalsPlanned : removed,
    removalsPlanned,
    staleRemovalSkipped: !mayRemoveStale,
    invalidIdentityCount,
    durationMs: Date.now() - startedAt,
  };

  log(
    `Reconciliation ${dryRun ? "(dry run) " : ""}completed: active=${summary.activeOnEbay} created=${summary.created} updated=${summary.updated} removed=${summary.removed} unchanged=${summary.unchanged} duplicates=${summary.duplicatesCollapsed} durationMs=${summary.durationMs}`
  );

  return summary;
}

/**
 * Count-only integrity report for the eBay Marketplace Listing dataset.
 * Used by scripts/reconcileEbayMarketplaceListings.js and safe to call from
 * anywhere without side effects.
 *
 * @returns {Promise<Object>} counts of every integrity dimension
 */
async function summarizeEbayMarketplaceListings() {
  const ebayFilter = { marketplace: "ebay" };

  const [totalEbayRecords, listingRecords, missingId, duplicatesAgg, unknownStatus] =
    await Promise.all([
      MarketplaceListing.countDocuments(ebayFilter),
      MarketplaceListing.countDocuments({ ...ebayFilter, marketplaceListingId: { $ne: null } }),
      MarketplaceListing.countDocuments({
        ...ebayFilter,
        $or: [
          { marketplaceListingId: null },
          { marketplaceListingId: { $exists: false } },
          { marketplaceListingId: "" },
        ],
      }),
      MarketplaceListing.aggregate([
        { $match: { ...ebayFilter, marketplaceListingId: { $ne: null } } },
        {
          $group: {
            _id: {
              marketplaceAccountId: "$marketplaceAccountId",
              marketplaceListingId: "$marketplaceListingId",
            },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
        { $count: "duplicateGroups" },
      ]),
      MarketplaceListing.countDocuments({ ...ebayFilter, listingStatus: "Unknown" }),
    ]);

  return {
    totalEbayRecords,
    listingRecords,
    missingListingId: missingId,
    duplicateGroups: duplicatesAgg?.[0]?.duplicateGroups || 0,
    unknownStatus,
  };
}

module.exports = {
  reconcileEbayListings,
  fetchAllActiveEbayListings,
  buildListingFieldsFromTradingItem,
  normalizeEbayListingStatus,
  summarizeEbayMarketplaceListings,
  resolveActiveEbayAccount,
  buildEbayAccountKey,
  ensureFreshEbayAccessToken,
};
