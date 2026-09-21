/**
 * eBay Catalog Sync Service
 *
 * Single authoritative engine for CRM → eBay catalog synchronization.
 * Used by: manual sync, scheduled 6-hour job, retry, single-product sync.
 *
 * Orchestrates:
 *   1. Fetch eligible active Inventory (not deleted)
 *   2. Apply exclusion rules before any mapping or API call
 *   3. Map each product to eBay payloads (InventoryItem + Offer + Compatibility)
 *   4. Create/update Inventory Items (PUT /inventory_item/{sku})
 *   5. Create/update vehicle fitment (PUT /product_compatibility/{sku})
 *   6. Create/update Offers (POST/PUT /offer)
 *   7. Publish Offers (POST /offer/{offerId}/publish)
 *   8. Verify publication against eBay's own remote state
 *   9. Persist eBay IDs and sync state back to Inventory
 *  10. Report results
 *
 * IMPORTANT (production-hardening note): this file previously had its
 * `module.exports` statement accidentally nested INSIDE the syncCatalog()
 * function body (a brace-matching corruption from a bad edit). That meant
 * `module.exports` was never assigned at require()-time — only if/when
 * syncCatalog() itself ran — so every consumer (`controllers/
 * ebayCatalogSync.controller.js`, `jobs/ebayCatalogSyncJob.js`) that did
 * `const { syncCatalog } = require(...)` received `syncCatalog: undefined`
 * and would throw "syncCatalog is not a function" on every single call,
 * scheduled or manual. The file below restores normal top-level function
 * declarations; no business logic from the original implementation was
 * removed.
 */
const EbaySyncRun = require("../../models/EbaySyncRun.model");
const Inventory = require("../../models/Inventory.model");
const IntegrationAccount = require("../../models/IntegrationAccount.model");
const platformManager = require("../platformManager.service");
const { EbayApiClient, EbayAuthError, EbayRateLimitError } = require("../clients/ebayApiClient");
const EbayTradingClient = require("../clients/ebayTradingClient");
const { mapProduct } = require("./ebayProductMapper");
const ebayConfig = require("../../config/ebayCatalogConfig");
const { runWithConcurrency } = require("../wixPartSync.service");

const client = new EbayApiClient();
const tradingClient = new EbayTradingClient();

/**
 * Ensure a valid eBay access token is available.
 * Tries to find an active eBay IntegrationAccount and refresh if needed.
 * @returns {Promise<string>} Valid access token
 * @throws {Error} If no configured eBay integration found
 */
async function ensureToken() {
  const account = await IntegrationAccount.findOne({
    platform: "ebay",
    isActive: true,
    refreshToken: { $ne: null },
  }).sort({ createdAt: -1 });

  if (!account) {
    throw new Error("No active eBay integration found. Connect eBay in Platform Connections first.");
  }

  // Refresh if needed (uses the existing adapter's refreshToken)
  if (account.needsTokenRefresh) {
    const adapter = platformManager.getAdapter("ebay");
    await adapter.refreshToken(account);
  }

  // Re-read the account for the refreshed token
  const refreshed = await IntegrationAccount.findById(account._id).lean();
  return refreshed.accessToken;
}

/**
 * Detects an eBay "offer already exists for this SKU" style error so a
 * retry after a lost/uncommitted CRM write doesn't blindly attempt (and
 * fail loudly on) a second createOffer call. eBay's Inventory API only
 * allows one offer per (SKU, marketplace, format) — a duplicate create
 * attempt comes back as a 4xx with a message to this effect.
 */
function isDuplicateOfferError(err) {
  const msg = String(err && err.message || "").toLowerCase();
  return msg.includes("already exists") || msg.includes("duplicate") || msg.includes("offer entity");
}

// ── Per-SKU in-process sync serialization ───────────────────────────────
// The global EbaySyncRun Mongo lock only guards a full syncCatalog() run
// (scheduled job / manual "Sync Now") — syncSingleProduct() (used by the
// single-product API and retryFailed) never acquires it, so a scheduled
// run and a manual retry targeting the SAME SKU could previously execute
// syncProduct() concurrently for that SKU (e.g. both racing to createOffer,
// or one's Phase D Mongo write clobbering the other's more recent state).
// A global lock would be the wrong fix here — it would block every OTHER,
// unrelated product just because one single-product retry is in flight.
// This mirrors wixPartSync.service.js's withIdentityLock() pattern (same
// single-process deployment assumption already documented there) but is
// implemented independently in this eBay-only file rather than importing
// from or modifying that Wix file — Wix code must stay untouched and must
// never gain an eBay dependency.
const ebaySkuQueues = new Map();
function withSkuLock(sku, task) {
  const previousTail = ebaySkuQueues.get(sku) || Promise.resolve();
  const runAfterPrevious = previousTail.catch(() => {}).then(() => task());
  ebaySkuQueues.set(sku, runAfterPrevious);
  runAfterPrevious.finally(() => {
    if (ebaySkuQueues.get(sku) === runAfterPrevious) {
      ebaySkuQueues.delete(sku);
    }
  }).catch(() => {});
  
  return runAfterPrevious;
}

/**
 * Wraps a lower-level error with a stage-specific message while preserving
 * its classification (statusCode / rate-limit / auth flags from
 * EbayApiClient's EbayApiError hierarchy). Without this, `throw new
 * Error(\`X failed: ${err.message}\`)` silently discards the original
 * error's type — a 401 auth failure and a 500 server error both collapse
 * into an indistinguishable plain Error, making error classification
 * (see classifySyncError below) impossible downstream.
 */
function wrapStageError(stage, err) {
  const wrapped = new Error(`${stage}: ${err.message}`);
  wrapped.statusCode = err.statusCode;
  wrapped.isRateLimited = err.isRateLimited;
  wrapped.originalName = err.name;
  wrapped.code = err.code; // e.g. ECONNRESET/ETIMEDOUT — required for classifySyncError's NETWORK_ERROR check
  return wrapped;
}

/**
 * Classifies a (possibly stage-wrapped) sync error into the fixed taxonomy
 * an operator/retry policy can act on, instead of an opaque message string.
 * Used only to LABEL ebaySyncError for observability — it does not change
 * whether a failure is retried (retry-failed always re-attempts; permanent
 * per-product validation failures like EXCLUDED/CATEGORY_ERROR never reach
 * this function at all, since mapProduct short-circuits those before any
 * API call is made).
 */
function classifySyncError(err) {
  if (!err) return "UNKNOWN_ERROR";
  if (err.category) return err.category; // pre-classified (e.g. VERIFICATION_ERROR)
  if (err.originalName === "EbayAuthError" || err instanceof EbayAuthError) return "AUTH_ERROR";
  if (err.isRateLimited || err instanceof EbayRateLimitError) return "RATE_LIMIT";
  if (err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ECONNABORTED") return "NETWORK_ERROR";
  if (typeof err.statusCode === "number" && err.statusCode >= 500) return "EBAY_SERVER_ERROR";
  if (typeof err.statusCode === "number" && err.statusCode >= 400) return "EBAY_API_ERROR";
  const msg = String(err.message || "");
  if (msg.includes("Post-publish verification failed")) return "VERIFICATION_ERROR";
  if (msg.includes("No active eBay integration") || msg.includes("token")) return "AUTH_ERROR";
  return "UNKNOWN_ERROR";
}

/**
 * Main catalog synchronization entry point.
 * Used by: manual API, scheduled cron job, retry, and single-product sync.
 *
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false] - Simulate only, no API calls
 * @param {number} [options.maxProducts=0] - 0 = no limit
 * @param {string} [options.trigger="manual"]
 * @param {string} [options.singleProductId] - Sync a single inventory ID
 * @param {number} [options.concurrency] - Override default concurrency
 * @returns {Promise<Object>} Sync result with counts and summary
 */
async function syncCatalog(options = {}) {
  const {
    dryRun = false,
    maxProducts = ebayConfig.EBAY_SYNC_MAX_PRODUCTS || 0,
    trigger = "manual",
    singleProductId = null,
    concurrency = ebayConfig.EBAY_SYNC_CONCURRENCY,
  } = options;

  const summary = {
    totalDiscovered: 0,
    totalEligible: 0,
    totalExcluded: 0,
    totalSkipped: 0,
    totalCreated: 0,
    totalUpdated: 0,
    totalUnchanged: 0,
    totalPublished: 0,
    totalFailed: 0,
    totalValidationErrors: 0,
    totalApiErrors: 0,
    failedSkus: [],
    excludedSkus: [],
    error: null,
  };

  // Declared here (not inside the try block below) so it's still in scope
  // at the function's final `return` after the try/catch.
  const failureDetails = [];

  const startTime = Date.now();
  let accessToken = null;

  try {
    // ── Phase 1: Token & Pre-checks ──────────────────────────────────
    if (!dryRun) {
      accessToken = await ensureToken();
    }

    // ── Phase 2: Fetch eligible Inventory ────────────────────────────

    let query = { isDeleted: { $ne: true } };

    if (singleProductId) {
      query._id = singleProductId;
    }

    const cursor = Inventory.find(query)
      .populate("make", "name")
      .populate("model", "name")
      .populate("trim", "name");

    if (maxProducts > 0 && !singleProductId) {
      cursor.limit(maxProducts);
    }

    const inventoryItems = await cursor.lean();
    summary.totalDiscovered = inventoryItems.length;

    console.log(`[EBAY_SYNC] Discovered ${summary.totalDiscovered} inventory items${singleProductId ? " (single product)" : ""}`);

    // ── Phase 3: Map all products (exclusions happen inside mapProduct) ─
    // mapProduct() is called once per item, in the same order as
    // inventoryItems, so pairing by index below is safe and avoids an
    // O(n^2) re-scan (`.find()` per eligible product) that would get
    // noticeably slow once the catalog reaches hundreds/thousands of rows.

    const mappedProducts = inventoryItems.map((item) => mapProduct(item, { dryRun }));

    const eligibleProducts = [];
    // Every mapping-stage failure's actual reason, not just its SKU — see
    // Phase B: previously a FAILED mapProduct() result (CATEGORY_ERROR,
    // VALIDATION_ERROR, NO_IMAGES, POLICY_CONFIGURATION_ERROR, ...) was
    // reduced to a bare SKU in `failedSkus`, with `mapped.reason`/
    // `mapped.errors` computed and then discarded — an operator hitting
    // POST /catalog-sync/run/:id had no way to see WHY without reading
    // server logs at the exact moment the run happened, and the Inventory
    // record itself was never updated (only failures INSIDE syncProduct()
    // were persisted; a mapping-stage failure never reaches syncProduct()).
    for (let i = 0; i < mappedProducts.length; i++) {
      const mapped = mappedProducts[i];
      if (mapped.status === "EXCLUDED") {
        summary.totalExcluded++;
        summary.excludedSkus.push(mapped.sku);
        continue;
      }
      if (mapped.status === "FAILED") {
        summary.totalValidationErrors++;
        summary.totalFailed++;
        summary.failedSkus.push(mapped.sku);

        failureDetails.push({
          sku: mapped.sku,
          reason: mapped.reason,
          errors: mapped.errors,
          warnings: mapped.warnings,
        });
        console.error(`[EBAY_SYNC] SKU=${mapped.sku} FAILED validation [${mapped.reason}]: ${mapped.errors.join("; ")}`);

        if (!dryRun) {
          try {
            await Inventory.findByIdAndUpdate(inventoryItems[i]._id, {
              $set: {
                ebaySyncStatus: "FAILED",
                ebaySyncError: `[${mapped.reason}] ${mapped.errors.join("; ")}`,
                ebayLastSyncedAt: new Date(),
              },
            });
          } catch (persistErr) {
            console.error(`[EBAY_SYNC] CRITICAL: failed to persist validation-failure state for SKU=${mapped.sku}: ${persistErr.message}`);
          }
        }
        continue;
      }
      // status === "MAPPED"
      eligibleProducts.push({ inventoryItem: inventoryItems[i], mapped });
    }

    summary.totalEligible = eligibleProducts.length;
    console.log(`[EBAY_SYNC] Eligible: ${summary.totalEligible}, Excluded: ${summary.totalExcluded}, Failed validation: ${summary.totalFailed}`);

    if (eligibleProducts.length === 0) {
      summary.totalSkipped = inventoryItems.length - summary.totalExcluded - summary.totalFailed;
      const durationMsEarly = Date.now() - startTime;
      console.log(`[EBAY_SYNC] Complete: ${durationMsEarly}ms | discovered=${summary.totalDiscovered} eligible=0 excluded=${summary.totalExcluded} failed=${summary.totalFailed}`);
      return { summary, failureDetails, durationMs: durationMsEarly, dryRun };
    }

    // ── Phase 4: Dry run — return mapped payloads without API calls ──

    if (dryRun) {
      console.log(`[EBAY_SYNC] DRY RUN: Would process ${eligibleProducts.length} products`);
      return {
        summary,
        failureDetails,
        mappedProducts: eligibleProducts.map((p) => ({
          sku: p.mapped.sku,
          productTitle: p.mapped.inventoryItemPayload?.product?.title || "N/A",
          categoryId: p.mapped.ebayCategoryId,
          price: p.mapped.offerPayload?.pricingSummary?.price?.value || "N/A",
          syncHash: p.mapped.syncHash,
          hasFitment: Boolean(p.mapped.compatibilityPayload),
          warnings: p.mapped.warnings,
          action: determineAction(p.inventoryItem, p.mapped),
        })),
        durationMs: Date.now() - startTime,
        dryRun: true,
      };
    }

    // ── Phase 5: Process eligible products with concurrency ──────────

    await runWithConcurrency(eligibleProducts, async (product) => {
      const { inventoryItem, mapped } = product;
      try {
        await withSkuLock(mapped.sku, () => syncProduct(inventoryItem, mapped, accessToken, summary));
      } catch (err) {
        summary.totalFailed++;
        summary.failedSkus.push(mapped.sku);
        const category = classifySyncError(err);
        console.error(`[EBAY_SYNC] Product ${mapped.sku} failed [${category}]:`, err.message);

        // Persist the failure to CRM for every failure path, not just
        // verification errors (which self-persist richer detail — offerId/
        // listingId — inside syncProduct and set err.alreadyPersisted so
        // this doesn't clobber that with a less-detailed generic write).
        // Without this, a createOrReplaceInventoryItem/createOffer/
        // updateOffer/publishOffer failure left the Inventory record's
        // ebaySyncStatus/ebaySyncError completely untouched — silently
        // stale, visible only in server logs.
        if (!err.alreadyPersisted) {
          try {
            await Inventory.findByIdAndUpdate(inventoryItem._id, {
              $set: {
                ebaySyncStatus: "FAILED",
                ebaySyncError: `[${category}] ${err.message}`,
                ebayLastSyncedAt: new Date(),
              },
            });
          } catch (persistErr) {
            console.error(`[EBAY_SYNC] CRITICAL: failed to persist failure state for SKU=${mapped.sku}: ${persistErr.message}`);
          }
        }
      }
    }, concurrency);

    // ── Phase 6: Final summary ───────────────────────────────────────
    // Skipped = discovered minus every product that was actually
    // classified (eligible OR excluded OR failed validation) — failed
    // validation must be subtracted here too, otherwise a validation
    // failure was double-counted as both "failed" and "skipped".
    summary.totalSkipped = summary.totalDiscovered - summary.totalEligible - summary.totalExcluded - summary.totalValidationErrors;
  } catch (err) {
    summary.error = err.message;
    console.error(`[EBAY_SYNC] Sync failed:`, err.message);
  }

  const durationMs = Date.now() - startTime;
  console.log(`[EBAY_SYNC] Complete: ${durationMs}ms | discovered=${summary.totalDiscovered} eligible=${summary.totalEligible} excluded=${summary.totalExcluded} created=${summary.totalCreated} updated=${summary.totalUpdated} published=${summary.totalPublished} failed=${summary.totalFailed}`);

  return { summary, failureDetails, durationMs, dryRun };
}

/**
 * Synchronize a single product: create/update inventory item, sync vehicle
 * fitment, create/update the offer, publish, verify, and persist state back
 * to Inventory.
 */

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Builds the <Item>...</Item> fields shared by AddFixedPriceItem and
 * ReviseFixedPriceItem, so the two request types can never drift apart
 * (e.g. one having fitment/policies and the other not). Trading API
 * Revise calls are PARTIAL updates by default — only fields present in
 * the request change — so sending this full, freshly-mapped field set on
 * every revise (not just the changed ones) guarantees the live listing
 * matches the current CRM state exactly, closing the "stale partial
 * payload" risk called out earlier in this audit.
 */
function buildMotorsItemFieldsXml(mapped) {
  const sku = mapped.sku;
  const product = mapped.inventoryItemPayload.product;

  const title = product.title;
  const description = mapped.offerPayload.listingDescription;
  const price = mapped.offerPayload.pricingSummary.price.value;
  const categoryId = mapped.ebayCategoryId;
  const imageUrls = product.imageUrls || [];
  const aspects = product.aspects || {};

  const itemSpecifics = Object.entries(aspects)
    .map(([name, values]) => {
      const valueArray = Array.isArray(values) ? values : [values];

      return `
        <NameValueList>
          <Name>${escapeXml(name)}</Name>
          ${valueArray
            .map((value) => `<Value>${escapeXml(value)}</Value>`)
            .join("")}
        </NameValueList>`;
    })
    .join("");

  // Vehicle fitment for the Motors Trading API. Matches eBay's documented
  // Item.ItemCompatibilityList schema: one <Compatibility> block per
  // compatible vehicle, each carrying its Year/Make/Model/Trim as sibling
  // NameValueList entries — the same shape mapProduct() already builds for
  // the REST Product Compatibility API (see ebayProductMapper.js), just
  // re-expressed as XML instead of JSON. Previously this block was fully
  // commented out AND the resulting variable was never even referenced in
  // the returned template — a Motors listing could never have carried
  // fitment data even if the comment-out had been the only problem.
  let compatibility = "";
  if (mapped.compatibilityPayload?.compatibleProducts?.length) {
    const properties =
      mapped.compatibilityPayload.compatibleProducts[0]
        .compatibilityProperties || [];

    if (properties.length) {
      compatibility = `
    <ItemCompatibilityList>
      <Compatibility>
        ${properties
          .map(
            (p) => `
        <NameValueList>
          <Name>${escapeXml(p.name)}</Name>
          <Value>${escapeXml(p.value)}</Value>
        </NameValueList>`
          )
          .join("")}
      </Compatibility>
    </ItemCompatibilityList>`;
    }
  }

  // Return policy: only included when explicitly configured (see
  // config/ebayCatalogConfig.js — no verified Return Profile ID exists yet
  // for this account, and the two currently-live Motors listings were
  // created with none, relying on the account's own default return
  // policy). Adding it is additive/opt-in so this never regresses
  // currently-working Motors listings.
  const returnProfile = ebayConfig.EBAY_MOTORS_RETURN_PROFILE_ID
    ? `
      <SellerReturnProfile>
        <ReturnProfileID>${escapeXml(ebayConfig.EBAY_MOTORS_RETURN_PROFILE_ID)}</ReturnProfileID>
      </SellerReturnProfile>`
    : "";

  return `
    <Title>${escapeXml(title)}</Title>

    <Description><![CDATA[${description}]]></Description>

    <PrimaryCategory>
      <CategoryID>${escapeXml(categoryId)}</CategoryID>
    </PrimaryCategory>

    <StartPrice>${escapeXml(price)}</StartPrice>
    <Quantity>1</Quantity>

    <ConditionID>3000</ConditionID>

    <SKU>${escapeXml(sku)}</SKU>

    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>

    <Country>US</Country>
    <Currency>USD</Currency>

    <Location>${escapeXml(ebayConfig.EBAY_MOTORS_LOCATION)}</Location>
    <PostalCode>${escapeXml(ebayConfig.EBAY_MOTORS_POSTAL_CODE)}</PostalCode>

    <DispatchTimeMax>2</DispatchTimeMax>

    <PictureDetails>
      ${imageUrls
        .slice(0, 12)
        .map((url) => `<PictureURL>${escapeXml(url)}</PictureURL>`)
        .join("")}
    </PictureDetails>

    <SellerProfiles>
      <SellerPaymentProfile>
        <PaymentProfileID>${escapeXml(ebayConfig.EBAY_MOTORS_PAYMENT_PROFILE_ID)}</PaymentProfileID>
      </SellerPaymentProfile>

      <SellerShippingProfile>
        <ShippingProfileID>${escapeXml(ebayConfig.EBAY_MOTORS_SHIPPING_PROFILE_ID)}</ShippingProfileID>
      </SellerShippingProfile>${returnProfile}
    </SellerProfiles>

    <ShippingServiceCostOverrideList>
      <ShippingServiceCostOverride>
        <ShippingServiceType>Domestic</ShippingServiceType>
        <ShippingServicePriority>1</ShippingServicePriority>
        <ShippingServiceCost>10.00</ShippingServiceCost>
        <ShippingServiceAdditionalCost>0.00</ShippingServiceAdditionalCost>
      </ShippingServiceCostOverride>
    </ShippingServiceCostOverrideList>

    <ItemSpecifics>
      ${itemSpecifics}
    </ItemSpecifics>
${compatibility}`;
}

function buildMotorsAddFixedPriceItemXml(mapped) {
  return `<?xml version="1.0" encoding="utf-8"?>
<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <Item>${buildMotorsItemFieldsXml(mapped)}
  </Item>
</AddFixedPriceItemRequest>`;
}

function buildMotorsReviseFixedPriceItemXml(mapped, itemId) {
  return `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <Item>
    <ItemID>${escapeXml(itemId)}</ItemID>${buildMotorsItemFieldsXml(mapped)}
  </Item>
</ReviseFixedPriceItemRequest>`;
}

/**
 * Builds a GetSellerList request that filters (server-side, via SKUArray)
 * to just the ONE given SKU — NOT a full seller-listing scan. Per eBay's
 * own Trading API docs (GetSellerListRequestType), SKUArray "filters
 * (reduces) the response to only include active listings that the seller
 * listed with any of the specified SKUs." This call additionally REQUIRES
 * an EndTimeFrom/EndTimeTo (or StartTimeFrom/StartTimeTo) window no wider
 * than 120 days — satisfied here with "now" to "now + 119 days", which
 * reliably covers any currently-active GTC listing regardless of its
 * original creation date, since a GTC listing's live EndTime is always
 * recalculated forward at each renewal and therefore always falls within
 * the next few weeks from "now", well inside this window.
 */
function buildGetSellerListBySkuXml(sku) {
  const now = new Date();
  const endTimeFrom = now.toISOString();
  const endTimeTo = new Date(now.getTime() + 119 * 24 * 60 * 60 * 1000).toISOString();

  return `<?xml version="1.0" encoding="utf-8"?>
<GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <SKUArray>
    <SKU>${escapeXml(sku)}</SKU>
  </SKUArray>
  <EndTimeFrom>${endTimeFrom}</EndTimeFrom>
  <EndTimeTo>${endTimeTo}</EndTimeTo>
  <Pagination>
    <EntriesPerPage>10</EntriesPerPage>
    <PageNumber>1</PageNumber>
  </Pagination>
  <GranularityLevel>Fine</GranularityLevel>
</GetSellerListRequest>`;
}

/**
 * Motors SKU reconciliation (Gap #6 from the production-hardening audit):
 * if Mongo lost `ebayListingId` for a Motors-category product but the SKU
 * is still actively listed on eBay, this performs a SAFE, TARGETED lookup
 * (GetSellerList filtered by SKUArray to exactly this one SKU — never a
 * full-catalog scan) to find the existing ItemID BEFORE syncMotorsProduct
 * would otherwise call AddFixedPriceItem and create a duplicate listing.
 * Mirrors the REST path's proven client.getOffers(accessToken, sku)
 * pre-create reconciliation pattern (see syncProduct's Phase B) — same
 * shape, same safety property, just the Trading API's equivalent call.
 * Returns the found ItemID (string) or null if genuinely not found.
 * Non-fatal on error: falls through to the normal create attempt, exactly
 * like the REST path's reconciliation try/catch.
 */
async function reconcileMotorsListingBySku(accessToken, sku) {
  let response;
  try {
    response = await tradingClient.getSellerList(accessToken, buildGetSellerListBySkuXml(sku));
  } catch (err) {
    console.warn(`[EBAY_MOTORS_SYNC] SKU=${sku} GetSellerList reconciliation lookup failed (continuing to create attempt): ${err.message}`);
    return null;
  }

  const result = response?.GetSellerListResponse;
  const ack = String(result?.Ack || "").toLowerCase();
  if (!result || (ack !== "success" && ack !== "warning")) {
    console.warn(`[EBAY_MOTORS_SYNC] SKU=${sku} GetSellerList reconciliation returned Ack=${result?.Ack || "unknown"} (continuing to create attempt)`);
    return null;
  }

  const rawItems = result.ItemArray?.Item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  const match = items.find((it) => String(xmlTextValue(it?.SKU)) === String(sku));
  return match ? String(xmlTextValue(match.ItemID)) : null;
}

function buildMotorsGetItemXml(itemId) {
  // IncludeItemCompatibilityList=true is REQUIRED for eBay to return
  // Item.ItemCompatibilityList at all — per eBay's own Trading API docs
  // (developer.ebay.com/api-docs/user-guides/static/trading-user-guide/
  // retrieve-compatibility-items.html): "ItemCompatibilityList is only
  // returned if the seller included item compatibility in the listing AND
  // IncludeItemCompatibilityList is set to true in the GetItem request."
  // DetailLevel=ReturnAll alone does NOT return it. Without this flag,
  // verifyMotorsListing() has no way to confirm fitment was actually saved
  // by eBay — it would either have to skip the check silently or falsely
  // claim verification never actually performed.
  return `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${escapeXml(itemId)}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeItemCompatibilityList>true</IncludeItemCompatibilityList>
</GetItemRequest>`;
}

/** fast-xml-parser (ignoreAttributes:false, attributeNamePrefix:"") returns
 * an element with both text and attributes as { "#text": "...", ...attrs }
 * — this unwraps that shape uniformly, whether or not attributes exist. */
function xmlTextValue(node) {
  if (node === null || node === undefined) return undefined;
  if (typeof node === "object") return node["#text"];
  return node;
}

/**
 * Post-publish/post-revise verification for the Motors Trading API path —
 * the REST path has had this since an earlier audit pass; the Motors path
 * previously had NONE (an "AddFixedPriceItemResponse Ack=Success" was
 * treated as complete proof, exactly what this audit's Phase 15 forbids).
 * Retrieves the actual live item via GetItem and cross-checks the fields
 * that matter before the caller is allowed to mark PUBLISHED/UPDATED.
 */
async function verifyMotorsListing(accessToken, itemId, mapped) {
  let response;
  try {
    response = await tradingClient.getItem(
      accessToken,
      buildMotorsGetItemXml(itemId)
    );
  } catch (err) {
    return { ok: false, error: `GetItem call failed: ${err.message}` };
  }

  const result = response?.GetItemResponse;
  const ack = String(result?.Ack || "").toLowerCase();
  if (!result || (ack !== "success" && ack !== "warning")) {
    const errors = Array.isArray(result?.Errors)
      ? result.Errors
      : result?.Errors
        ? [result.Errors]
        : [];
    const message = errors
      .map((e) => `${e.ErrorCode || ""}: ${e.LongMessage || e.ShortMessage || ""}`)
      .join(" | ");
    return { ok: false, error: `GetItem returned Ack=${result?.Ack || "unknown"}: ${message || "no detail"}` };
  }

  const item = result.Item;
  if (!item) {
    return { ok: false, error: "GetItem response contained no Item" };
  }

  const remoteSku = xmlTextValue(item.SKU);
  const remoteTitle = xmlTextValue(item.Title);
  const remotePrice = xmlTextValue(item.StartPrice) ?? xmlTextValue(item.SellingStatus?.CurrentPrice);
  const remoteStatus = xmlTextValue(item.SellingStatus?.ListingStatus);

  const expectedSku = mapped.sku;
  const expectedTitle = mapped.inventoryItemPayload.product.title;
  const expectedPrice = mapped.offerPayload.pricingSummary.price.value;

  if (remoteSku !== undefined && String(remoteSku) !== String(expectedSku)) {
    return { ok: false, error: `SKU mismatch (expected ${expectedSku}, eBay reports ${remoteSku})` };
  }
  if (remoteTitle !== undefined && String(remoteTitle) !== String(expectedTitle)) {
    return { ok: false, error: `Title mismatch (expected "${expectedTitle}", eBay reports "${remoteTitle}")` };
  }
  if (remotePrice !== undefined && Number(remotePrice) !== Number(expectedPrice)) {
    return { ok: false, error: `Price mismatch (expected ${expectedPrice}, eBay reports ${remotePrice})` };
  }
  if (remoteStatus !== undefined && remoteStatus !== "Active" && remoteStatus !== "Custom") {
    return { ok: false, error: `Listing status is "${remoteStatus}", expected Active` };
  }

  // ── Fitment / vehicle compatibility verification ──────────────────────
  // Only meaningful when this product actually carries fitment data (see
  // mapProduct()'s Phase 8b — Year/Make/Model can be legitimately absent,
  // in which case compatibilityPayload is null and there is nothing to
  // verify). The request now sets IncludeItemCompatibilityList=true (see
  // buildMotorsGetItemXml) specifically so this comparison is possible at
  // all — without that flag eBay never returns ItemCompatibilityList, and
  // this function must NOT claim fitment was verified in that case.
  const expectedProperties =
    mapped.compatibilityPayload?.compatibleProducts?.[0]?.compatibilityProperties || [];

  let fitmentVerified = "not_applicable";
  if (expectedProperties.length > 0) {
    const rawCompatList = item.ItemCompatibilityList?.Compatibility;
    const remoteCompatBlocks = Array.isArray(rawCompatList)
      ? rawCompatList
      : rawCompatList
        ? [rawCompatList]
        : [];

    if (remoteCompatBlocks.length === 0) {
      return {
        ok: false,
        error: `Fitment mismatch: expected vehicle compatibility (${expectedProperties.map((p) => `${p.name}=${p.value}`).join(", ")}) but eBay's GetItem response contained no ItemCompatibilityList`,
      };
    }

    // We only ever send ONE Compatibility block per mapProduct()'s Phase 8b
    // (a single Year/Make/Model/Trim tuple, not a fitment table) — check
    // that at least one returned block matches every expected property
    // exactly, rather than assuming array position/order is preserved.
    const matchFound = remoteCompatBlocks.some((block) => {
      const rawList = block?.NameValueList;
      const entries = Array.isArray(rawList) ? rawList : rawList ? [rawList] : [];
      const remoteMap = {};
      for (const entry of entries) {
        const name = xmlTextValue(entry?.Name);
        const value = xmlTextValue(entry?.Value);
        if (name !== undefined) remoteMap[String(name).toLowerCase()] = value;
      }
      return expectedProperties.every(
        (p) => String(remoteMap[p.name.toLowerCase()] ?? "") === String(p.value)
      );
    });

    if (!matchFound) {
      return {
        ok: false,
        error: `Fitment mismatch: expected vehicle compatibility (${expectedProperties.map((p) => `${p.name}=${p.value}`).join(", ")}) not found in eBay's returned ItemCompatibilityList`,
      };
    }
    fitmentVerified = true;
  }

  return {
    ok: true,
    remoteState: { sku: remoteSku, title: remoteTitle, price: remotePrice, status: remoteStatus, fitmentVerified },
  };
}

async function syncMotorsProduct(inventoryItem, mapped, accessToken, summary) {
  const sku = mapped.sku;
  let existingListingId = inventoryItem.ebayListingId;
  let isNewListing = !existingListingId;

  // ── SKU reconciliation (Gap #6, corrected from an earlier audit pass) ──
  // An earlier pass concluded no safe by-SKU lookup existed on the Trading
  // API and documented this as a hard limitation. Further research this
  // session found that's WRONG: GetSellerList's SKUArray field ("filters
  // (reduces) the response to only include active listings that the seller
  // listed with any of the specified SKUs" — developer.ebay.com's
  // GetSellerListRequestType docs) provides exactly the targeted, single-
  // SKU lookup needed — genuinely analogous to the REST path's
  // client.getOffers(accessToken, sku), NOT the "expensive full seller-list
  // scan" this audit was told to avoid. See reconcileMotorsListingBySku()
  // above. If Mongo ever lost ebayListingId while the SKU is still live on
  // eBay, this closes that gap the same way the REST path already does.
  if (isNewListing) {
    const reconciledItemId = await reconcileMotorsListingBySku(accessToken, sku);
    if (reconciledItemId) {
      console.log(`[EBAY_MOTORS_SYNC] SKU=${sku} reconciled existing eBay ItemID=${reconciledItemId} found via GetSellerList before create (Mongo had none)`);
      existingListingId = reconciledItemId;
      isNewListing = false;
      try {
        await Inventory.findByIdAndUpdate(inventoryItem._id, {
          $set: { ebaySku: sku, ebayListingId: reconciledItemId, ebayMarketplaceId: "EBAY_MOTORS_US" },
        });
      } catch (persistErr) {
        console.error(`[EBAY_MOTORS_SYNC] CRITICAL: SKU=${sku} reconciled ItemID=${reconciledItemId} but interim persist failed: ${persistErr.message}`);
      }
    }
  }

  console.log(
    `[EBAY_MOTORS_SYNC] SKU=${sku} ACTION=${isNewListing ? "CREATE" : "UPDATE"} CATEGORY=${mapped.ebayCategoryId} PRICE=${mapped.offerPayload.pricingSummary.price.value}`
  );

  let listingId = existingListingId;

  if (isNewListing) {
    const xml = buildMotorsAddFixedPriceItemXml(mapped);
    let response;
    try {
      response = await tradingClient.call(accessToken, "AddFixedPriceItem", xml);
    } catch (err) {
      summary.totalApiErrors++;
      throw wrapStageError("eBay Motors AddFixedPriceItem failed", err);
    }

    const result = response?.AddFixedPriceItemResponse;
    if (!result) {
      summary.totalApiErrors++;
      throw new Error("eBay Motors returned an invalid AddFixedPriceItem response");
    }

    const ack = String(result.Ack || "").toLowerCase();
    if (ack === "failure") {
      summary.totalApiErrors++;
      const errors = Array.isArray(result.Errors) ? result.Errors : result.Errors ? [result.Errors] : [];
      const message = errors
        .map((e) => `${e.ErrorCode || ""}: ${e.LongMessage || e.ShortMessage || ""}`)
        .join(" | ");
      throw new Error(`eBay Motors listing creation failed: ${message || "Unknown eBay error"}`);
    }

    listingId = result.ItemID;
    if (!listingId) {
      summary.totalApiErrors++;
      throw new Error("eBay Motors returned success but no ItemID");
    }

    console.log(`[EBAY_MOTORS_SYNC] SKU=${sku} AddFixedPriceItem SUCCESS ITEM_ID=${listingId}`);

    // Persist the ItemID immediately, before verification — mirrors the
    // REST path's crash-safety pattern (persist offerId before publish):
    // if verification below throws/crashes, the next run must see this
    // ItemID and go through the REVISE branch, never AddFixedPriceItem
    // again for the same SKU.
    try {
      await Inventory.findByIdAndUpdate(inventoryItem._id, {
        $set: { ebaySku: sku, ebayListingId: String(listingId), ebayMarketplaceId: "EBAY_MOTORS_US" },
      });
    } catch (persistErr) {
      console.error(`[EBAY_MOTORS_SYNC] CRITICAL: SKU=${sku} ItemID=${listingId} created but interim persist failed: ${persistErr.message}`);
    }
  } else {
    const xml = buildMotorsReviseFixedPriceItemXml(mapped, existingListingId);
    let response;
    try {
      response = await tradingClient.reviseFixedPriceItem(accessToken, xml);
    } catch (err) {
      summary.totalApiErrors++;
      throw wrapStageError("eBay Motors ReviseFixedPriceItem failed", err);
    }

    const result = response?.ReviseFixedPriceItemResponse;
    if (!result) {
      summary.totalApiErrors++;
      throw new Error("eBay Motors returned an invalid ReviseFixedPriceItem response");
    }

    const ack = String(result.Ack || "").toLowerCase();
    if (ack === "failure") {
      summary.totalApiErrors++;
      const errors = Array.isArray(result.Errors) ? result.Errors : result.Errors ? [result.Errors] : [];
      const message = errors
        .map((e) => `${e.ErrorCode || ""}: ${e.LongMessage || e.ShortMessage || ""}`)
        .join(" | ");
      throw new Error(`eBay Motors listing revise failed: ${message || "Unknown eBay error"}`);
    }

    console.log(`[EBAY_MOTORS_SYNC] SKU=${sku} ReviseFixedPriceItem SUCCESS ITEM_ID=${listingId}`);
  }

  // ── Post-publish/post-revise verification ────────────────────────────
  const verification = await verifyMotorsListing(accessToken, listingId, mapped);

  if (!verification.ok) {
    summary.totalApiErrors++;
    console.error(`[EBAY_MOTORS_SYNC] SKU=${sku} VERIFICATION FAILED: ${verification.error}`);
    // IDs preserved, hash NOT advanced — mirrors the REST path's
    // verification-failure handling so the next run retries/re-verifies
    // instead of silently reporting success.
    try {
      await Inventory.findByIdAndUpdate(inventoryItem._id, {
        $set: {
          ebaySku: sku,
          ebayListingId: String(listingId),
          ebayMarketplaceId: "EBAY_MOTORS_US",
          ebayCategoryId: mapped.ebayCategoryId,
          ebaySyncStatus: "FAILED",
          ebaySyncError: `VERIFICATION_ERROR: ${verification.error}`,
          ebayLastSyncedAt: new Date(),
        },
      });
    } catch (persistErr) {
      console.error(`[EBAY_MOTORS_SYNC] CRITICAL: SKU=${sku} verification failed AND persist failed: ${persistErr.message}`);
    }
    const verErr = new Error(`Post-publish verification failed: ${verification.error}`);
    verErr.category = "VERIFICATION_ERROR";
    verErr.alreadyPersisted = true;
    throw verErr;
  }

  console.log(`[EBAY_MOTORS_SYNC] SKU=${sku} VERIFICATION SUCCESS STATUS=${verification.remoteState.status}`);

  await Inventory.findByIdAndUpdate(inventoryItem._id, {
    $set: {
      ebaySku: sku,
      ebayListingId: String(listingId),
      ebayMarketplaceId: "EBAY_MOTORS_US",
      ebayCategoryId: mapped.ebayCategoryId,
      ebaySyncStatus: isNewListing ? "PUBLISHED" : "UPDATED",
      ebaySyncHash: mapped.syncHash,
      ebayLastSyncedAt: new Date(),
      ebaySyncError: null,
    },
  });

  if (isNewListing) {
    summary.totalCreated++;
    summary.totalPublished++;
  } else {
    summary.totalUpdated++;
  }

  return { listingId: String(listingId) };
}

async function syncProduct(inventoryItem, mapped, accessToken, summary) {
  const sku = mapped.sku;
  const inventoryItemPayload = mapped.inventoryItemPayload;
  const offerPayload = mapped.offerPayload;

  console.log(`[EBAY_SYNC] Processing SKU=${sku} title="${inventoryItemPayload?.product?.title || "N/A"}"`);

  // ── Determine whether this product already exists on eBay ──────────
  //
  // Re-read the CURRENT eBay-state fields fresh from Mongo here, INSIDE
  // the per-SKU lock's critical section (syncProduct only starts once
  // withSkuLock grants it this SKU's turn) — the `inventoryItem` argument
  // may be a stale snapshot from syncCatalog()'s one-time batch query at
  // the top of the run, taken BEFORE a concurrent sync for this same SKU
  // (e.g. two overlapping single-product retries) already completed and
  // persisted new state. Without this re-read, two callers serialized by
  // the SAME lock would each still compute isNewListing from their own
  // stale copy and both report "created" in their own run summary, even
  // though the lock already correctly ensures only one of them actually
  // calls createOffer (proven via the reconciliation path below) — a
  // count-only inaccuracy, not a duplicate-listing bug, but worth closing
  // now that the lock makes it possible to get a genuinely fresh read.
  const freshState = await Inventory.findById(inventoryItem._id).select("ebayOfferId ebayListingId ebaySyncHash").lean();
  const existingOfferId = freshState ? freshState.ebayOfferId : inventoryItem.ebayOfferId;
  const existingListingId = freshState ? freshState.ebayListingId : inventoryItem.ebayListingId;
  const existingSyncHash = freshState ? freshState.ebaySyncHash : inventoryItem.ebaySyncHash;
  // Captured once, up front, and NOT counted into summary.totalCreated/
  // totalUpdated/totalPublished until verification actually succeeds below
  // — otherwise a product whose Inventory Item PUT succeeds but whose
  // later Offer/Publish/Verification step fails would be counted as both
  // "created" AND "failed" for the same run (a duplicate-counting bug).
  const isNewListing = !existingListingId;

  // If sync hash matches, the product is unchanged — skip entirely
  if (existingSyncHash === mapped.syncHash && existingListingId) {
    summary.totalUnchanged++;
    console.log(`[EBAY_SYNC] SKU=${sku} UNCHANGED (hash match)`);
    return;
  }

  // eBay Motors Parts & Accessories use the Trading API.
  if (String(mapped.ebayCategoryId) === "33543") {
    return syncMotorsProduct(
      inventoryItem,
      mapped,
      accessToken,
      summary
    );
  }

  // ── Phase A: Create or replace Inventory Item ────────────────────

  try {
    await client.createOrReplaceInventoryItem(accessToken, sku, inventoryItemPayload);
    console.log(`[EBAY_SYNC] SKU=${sku} inventory item ${isNewListing ? "created" : "updated"}`);
  } catch (err) {
    summary.totalApiErrors++;
    throw wrapStageError("createOrReplaceInventoryItem failed", err);
  }

  // ── Phase A2: Vehicle fitment / compatibility ────────────────────
  // Fitment is mandatory when a compatibility payload exists.
  // If eBay rejects the fitment update, do NOT continue to
  // Offer / Publish. The product must fail and remain retryable.
  let fitmentError = null;
  if (mapped.compatibilityPayload) {
    try {
      await client.createOrReplaceProductCompatibility(accessToken, sku, mapped.compatibilityPayload);
      console.log(`[EBAY_SYNC] SKU=${sku} vehicle fitment synced`);
    } catch (err) {
      summary.totalApiErrors++;

      throw wrapStageError("product compatibility sync failed", err);

      // fitmentError = `Fitment sync failed: ${err.message}`;
      // console.error(`[EBAY_SYNC] SKU=${sku} ${fitmentError}`);
    }
  } else if (mapped.warnings && mapped.warnings.length) {
    fitmentError = mapped.warnings.join("; ");
  }

  // ── Phase B: Create or update Offer ──────────────────────────────

  let offerId = existingOfferId;
  // True whenever offerId comes from a reconciliation/recovery lookup
  // rather than (a) Mongo's own existingOfferId (already updateOffer'd
  // above) or (b) a fresh createOffer (whose data already IS offerPayload)
  // — a reconciled offer may hold stale data from whenever it was
  // originally created, so it needs the same updateOffer refresh.
  let offerNeedsDataRefresh = false;

  if (offerId) {
    // Update existing offer
    try {
      await client.updateOffer(accessToken, offerId, offerPayload);
      console.log(`[EBAY_SYNC] SKU=${sku} offer ${offerId} updated`);
    } catch (err) {
      // If update fails, try to create a new offer
      if (err.statusCode === 404) {
        offerId = null;
      } else {
        summary.totalApiErrors++;
        throw wrapStageError("updateOffer failed", err);
      }
    }
  }

  if (!offerId) {
    // Gap #5 (SKU reconciliation): proactively check whether eBay already
    // has an offer for this SKU BEFORE attempting to create one — e.g. a
    // previous run's createOffer succeeded but the process crashed/
    // restarted before persisting ebayOfferId to Mongo, so this run sees
    // existingOfferId as null even though eBay already has one. This uses
    // the same getOffers() call already trusted below for reactive
    // duplicate recovery, just moved earlier so reconciliation is
    // deterministic rather than depending on eBay returning a "duplicate"
    // error whose exact wording isDuplicateOfferError() has to string-match.
    try {
      const existingOnEbay = await client.getOffers(accessToken, sku);
      const foundOffer = existingOnEbay?.offers?.[0];
      if (foundOffer?.offerId) {
        offerId = foundOffer.offerId;
        offerNeedsDataRefresh = true;
        console.log(`[EBAY_SYNC] SKU=${sku} reconciled existing offer ${offerId} found on eBay before create (Mongo had none)`);
      }
    } catch (err) {
      // Non-fatal: if this lookup itself fails (e.g. transient network
      // error), fall through to the normal create attempt below, which
      // still has its own reactive isDuplicateOfferError recovery as a
      // second safety net.
      console.warn(`[EBAY_SYNC] SKU=${sku} pre-create reconciliation lookup failed (continuing to create attempt): ${err.message}`);
    }
  }

  if (!offerId) {
    // Create new offer
    // DIAGNOSTIC: log the exact outgoing Offer payload before the API call
    // (not the request itself — this is a read-only console.log of the
    // already-built offerPayload object). Contains only listing data (sku,
    // marketplaceId, format, listingDuration, availableQuantity, categoryId,
    // listingDescription, merchantLocationKey, listingPolicies IDs,
    // pricingSummary) — never an OAuth token or credential — so it is safe
    // to log unredacted and lets a createOffer failure be diffed field-by-
    // field against a known-successful SKU's payload from the logs alone.
    console.log(`[EBAY_SYNC] SKU=${sku} createOffer request payload: ${JSON.stringify(offerPayload)}`);
    try {
      const offerResult = await client.createOffer(accessToken, offerPayload);
      offerId = offerResult.offerId;
      console.log(`[EBAY_SYNC] SKU=${sku} offer ${offerId} created`);
    } catch (err) {
      // Recover instead of failing outright if eBay reports an offer
      // already exists for this SKU — this happens when a PREVIOUS run
      // created the offer but crashed/timed out before persisting
      // ebayOfferId back to Mongo (see the immediate-persist call right
      // below, which closes that gap going forward for new runs).
      if (isDuplicateOfferError(err)) {
        console.warn(`[EBAY_SYNC] SKU=${sku} createOffer reported a duplicate — recovering existing offer via getOffers`);
        const existing = await client.getOffers(accessToken, sku);
        const recovered = existing?.offers?.[0];
        if (!recovered?.offerId) {
          summary.totalApiErrors++;
          throw wrapStageError(`createOffer failed and no existing offer could be recovered for SKU ${sku}`, err);
        }
        offerId = recovered.offerId;
        offerNeedsDataRefresh = true;
        console.log(`[EBAY_SYNC] SKU=${sku} recovered existing offerId=${offerId}`);
      } else {
        summary.totalApiErrors++;
        throw wrapStageError("createOffer failed", err);
      }
    }

    // Persist the offerId immediately, BEFORE attempting to publish. If the
    // publish step below crashes/times out, the next run must see this
    // offerId (via existingOfferId) and go through updateOffer, NOT
    // createOffer again — otherwise a timeout during publish would cause a
    // duplicate offer to be created on retry.
    try {
      await Inventory.findByIdAndUpdate(inventoryItem._id, { $set: { ebaySku: sku, ebayOfferId: offerId } });
    } catch (persistErr) {
      console.error(`[EBAY_SYNC] CRITICAL: SKU=${sku} offer ${offerId} created but interim persist failed: ${persistErr.message}`);
    }
  }

  if (offerNeedsDataRefresh) {
    try {
      await client.updateOffer(accessToken, offerId, offerPayload);
      console.log(`[EBAY_SYNC] SKU=${sku} reconciled offer ${offerId} refreshed with current data`);
    } catch (err) {
      summary.totalApiErrors++;
      throw wrapStageError("updateOffer (post-reconciliation refresh) failed", err);
    }
  }

  // ── Phase C: Publish Offer (if not already published) ─────────────

  let listingId = existingListingId;

  if (!listingId) {
    try {
      const publishResult = await client.publishOffer(accessToken, offerId);
      listingId = publishResult.listingId;
      console.log(`[EBAY_SYNC] SKU=${sku} publish requested listingId=${listingId}`);
    } catch (err) {
      // If the error indicates already published, try to recover listingId
      if (err.message && err.message.includes("already published")) {
        console.log(`[EBAY_SYNC] SKU=${sku} offer already published, recovering listing ID...`);
        const offerDetail = await client.getOffer(accessToken, offerId);
        listingId = offerDetail.listing?.listingId || null;
        if (listingId) {
          console.log(`[EBAY_SYNC] SKU=${sku} recovered listingId=${listingId}`);
        }
      }
      if (!listingId) {
        summary.totalApiErrors++;
        throw wrapStageError("publishOffer failed", err);
      }
    }
  } else {
    console.log(`[EBAY_SYNC] SKU=${sku} already published (listingId=${listingId}), updates applied`);
  }

  // ── Phase C2: Post-publish verification ──────────────────────────
  // A 200 response / a returned listingId is NOT proof the listing
  // actually reflects our data on eBay's side. Re-read the offer and cross
  // check the fields that matter before trusting PUBLISHED/UPDATED.
  let verificationError = null;
  try {
    const offerDetail = await client.getOffer(accessToken, offerId);
    const remoteListingId = offerDetail?.listing?.listingId || null;
    const remoteStatus = offerDetail?.status || null;
    const remotePrice = offerDetail?.pricingSummary?.price?.value;
    const expectedPrice = offerPayload.pricingSummary.price.value;

    if (!remoteListingId || remoteListingId !== listingId) {
      verificationError = `listingId mismatch (expected ${listingId}, eBay reports ${remoteListingId})`;
    } else if (remoteStatus !== "PUBLISHED") {
      verificationError = `offer status is "${remoteStatus}", expected PUBLISHED`;
    } else if (remotePrice !== undefined && String(remotePrice) !== String(expectedPrice)) {
      verificationError = `price mismatch (expected ${expectedPrice}, eBay reports ${remotePrice})`;
    }
  } catch (err) {
    verificationError = `verification call failed: ${err.message}`;
  }

  if (verificationError) {
    summary.totalApiErrors++;
    // Real IDs ARE persisted below (so the next run recovers/updates rather
    // than recreating) but the sync hash is deliberately NOT advanced, so
    // this product is re-attempted (and re-verified) on the next run
    // instead of being silently reported as a success.
    try {
      await Inventory.findByIdAndUpdate(inventoryItem._id, {
        $set: {
          ebaySku: sku,
          ebayOfferId: offerId,
          ebayListingId: listingId,
          // REST path (syncProduct) persists the REST marketplace, not the
          // shared/Trading-oriented EBAY_MARKETPLACE_ID — see
          // EBAY_REST_MARKETPLACE_ID in ebayCatalogConfig.js.
          ebayMarketplaceId: ebayConfig.EBAY_REST_MARKETPLACE_ID,
          ebayCategoryId: mapped.ebayCategoryId,
          ebaySyncStatus: "FAILED",
          ebaySyncError: `VERIFICATION_ERROR: ${verificationError}`,
          ebayLastSyncedAt: new Date(),
        },
      });
    } catch (persistErr) {
      console.error(`[EBAY_SYNC] CRITICAL: SKU=${sku} verification failed AND persist failed: ${persistErr.message}`);
    }
    const verErr = new Error(`Post-publish verification failed: ${verificationError}`);
    verErr.category = "VERIFICATION_ERROR";
    // This function already persisted the richer detail above (offerId,
    // listingId, category ID) — the generic per-product catch in
    // syncCatalog must not overwrite it with a less-detailed generic write.
    verErr.alreadyPersisted = true;
    throw verErr;
  }

  // Verification passed — NOW it's safe to count this product as
  // created/updated/published (see isNewListing's doc comment above for
  // why this is deferred instead of counted at Phase A).
  if (isNewListing) {
    summary.totalCreated++;
    summary.totalPublished++;
  } else {
    summary.totalUpdated++;
  }

  // ── Phase D: Persist sync state back to CRM ─────────────────────

  try {
    await Inventory.findByIdAndUpdate(inventoryItem._id, {
      $set: {
        ebaySku: sku,
        ebayOfferId: offerId,
        ebayListingId: listingId,
        // See the matching comment in the verification-failure persist
        // block above — REST persists EBAY_REST_MARKETPLACE_ID, not the
        // Trading-oriented EBAY_MARKETPLACE_ID.
        ebayMarketplaceId: ebayConfig.EBAY_REST_MARKETPLACE_ID,
        ebayCategoryId: mapped.ebayCategoryId,
        ebaySyncStatus: listingId ? "PUBLISHED" : "UPDATED",
        ebaySyncHash: mapped.syncHash,
        ebayLastSyncedAt: new Date(),
        ebaySyncError: fitmentError,
      },
    });
    console.log(`[EBAY_SYNC] SKU=${sku} sync state persisted (verified)`);
  } catch (persistErr) {
    // Non-fatal: the eBay listing exists and is verified, but CRM tracking
    // failed to record it.
    console.error(`[EBAY_SYNC] CRITICAL: SKU=${sku} eBay listing ${listingId} exists but persist to CRM failed: ${persistErr.message}`);
  }
}

/**
 * Determine what action would be taken for a product (dry-run helper).
 */
function determineAction(inventoryItem, mapped) {
  if (!inventoryItem.ebayListingId) return "CREATE_AND_PUBLISH";
  if (inventoryItem.ebaySyncHash !== mapped.syncHash) return "UPDATE";
  return "UNCHANGED";
}

// ─── Single-product public helper ───────────────────────────────────────────

/**
 * Synchronize a single Inventory product by Mongo _id.
 */
async function syncSingleProduct(inventoryId, dryRun = false) {
  return syncCatalog({ singleProductId: inventoryId, dryRun, trigger: "single-product" });
}

// ─── Export ──────────────────────────────────────────────────────────────────

module.exports = {
  syncCatalog,
  syncSingleProduct,
  // Exported for direct unit testing of XML generation without needing a
  // live eBay call or a database — pure string builders, no side effects.
  _internal: {
    buildMotorsAddFixedPriceItemXml,
    buildMotorsReviseFixedPriceItemXml,
    buildMotorsGetItemXml,
    buildGetSellerListBySkuXml,
    xmlTextValue,
    verifyMotorsListing,
    reconcileMotorsListingBySku,
    withSkuLock,
  },
};
