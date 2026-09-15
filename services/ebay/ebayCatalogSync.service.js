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
      return { summary, durationMs: durationMsEarly, dryRun };
    }

    // ── Phase 4: Dry run — return mapped payloads without API calls ──

    if (dryRun) {
      console.log(`[EBAY_SYNC] DRY RUN: Would process ${eligibleProducts.length} products`);
      return {
        summary,
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
        await syncProduct(inventoryItem, mapped, accessToken, summary);
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

  return { summary, durationMs, dryRun };
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

function buildMotorsAddFixedPriceItemXml(inventoryItem, mapped) {
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

  let compatibility = "";

  // if (mapped.compatibilityPayload?.compatibleProducts?.length) {
  //   const properties =
  //     mapped.compatibilityPayload.compatibleProducts[0]
  //       .compatibilityProperties || [];

  //   compatibility = `
  //     <ItemCompatibilityList>
  //       <Compatibility>
  //         ${properties
  //           .map(
  //             (p) => `
  //           <NameValueList>
  //             <Name>${escapeXml(p.name)}</Name>
  //             <Value>${escapeXml(p.value)}</Value>
  //           </NameValueList>`
  //           )
  //           .join("")}
  //       </Compatibility>
  //     </ItemCompatibilityList>`;
  // }

  return `<?xml version="1.0" encoding="utf-8"?>
<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>

  <Item>
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

    <Location>Wrightstown, NJ</Location>
    <PostalCode>08562</PostalCode>

    <DispatchTimeMax>2</DispatchTimeMax>

    <PictureDetails>
      ${imageUrls
        .slice(0, 12)
        .map((url) => `<PictureURL>${escapeXml(url)}</PictureURL>`)
        .join("")}
    </PictureDetails>

    <SellerProfiles>
      <SellerPaymentProfile>
        <PaymentProfileID>322686018011</PaymentProfileID>
      </SellerPaymentProfile>

      <SellerShippingProfile>
        <ShippingProfileID>322686093011</ShippingProfileID>
      </SellerShippingProfile>
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

  </Item>
</AddFixedPriceItemRequest>`;
}

async function syncMotorsProduct(inventoryItem, mapped, accessToken, summary) {
  const sku = mapped.sku;

  console.log(
    `[EBAY_MOTORS_SYNC] Processing SKU=${sku} category=${mapped.ebayCategoryId}`
  );

  const existingListingId = inventoryItem.ebayListingId;

  if (existingListingId) {
    throw new Error(
      `Motors update path not yet enabled for ItemID=${existingListingId}`
    );
  }

  const xml = buildMotorsAddFixedPriceItemXml(
    inventoryItem,
    mapped
  );

  let response;

  try {
    response = await tradingClient.call(
      accessToken,
      "AddFixedPriceItem",
      xml
    );
  } catch (err) {
    summary.totalApiErrors++;
    throw wrapStageError(
      "eBay Motors AddFixedPriceItem failed",
      err
    );
  }

  const result = response?.AddFixedPriceItemResponse;

  if (!result) {
    summary.totalApiErrors++;
    throw new Error(
      "eBay Motors returned an invalid AddFixedPriceItem response"
    );
  }

  const ack = String(result.Ack || "").toLowerCase();

  if (ack === "failure") {
    summary.totalApiErrors++;

    const errors = Array.isArray(result.Errors)
      ? result.Errors
      : result.Errors
        ? [result.Errors]
        : [];

    const message = errors
      .map(
        (e) =>
          `${e.ErrorCode || ""}: ${
            e.LongMessage || e.ShortMessage || ""
          }`
      )
      .join(" | ");

    throw new Error(
      `eBay Motors listing creation failed: ${
        message || "Unknown eBay error"
      }`
    );
  }

  const listingId = result.ItemID;

  if (!listingId) {
    summary.totalApiErrors++;
    throw new Error(
      "eBay Motors returned success but no ItemID"
    );
  }

  console.log(
    `[EBAY_MOTORS_SYNC] SUCCESS SKU=${sku} ItemID=${listingId}`
  );

  await Inventory.findByIdAndUpdate(
    inventoryItem._id,
    {
      $set: {
        ebaySku: sku,
        ebayListingId: String(listingId),
        ebayMarketplaceId: "EBAY_MOTORS_US",
        ebayCategoryId: mapped.ebayCategoryId,
        ebaySyncStatus: "PUBLISHED",
        ebaySyncHash: mapped.syncHash,
        ebayLastSyncedAt: new Date(),
        ebaySyncError: null,
      },
    }
  );

  summary.totalCreated++;
  summary.totalPublished++;

  return {
    listingId: String(listingId),
  };
}

async function syncProduct(inventoryItem, mapped, accessToken, summary) {
  const sku = mapped.sku;
  const inventoryItemPayload = mapped.inventoryItemPayload;
  const offerPayload = mapped.offerPayload;

  // eBay Motors Parts & Accessories use the Trading API.
  // if (String(mapped.ebayCategoryId) === "33543") {
  //   return syncMotorsProduct(
  //     inventoryItem,
  //     mapped,
  //     accessToken,
  //     summary
  //   );
  // }

  console.log(`[EBAY_SYNC] Processing SKU=${sku} title="${inventoryItemPayload?.product?.title || "N/A"}"`);

  // ── Determine whether this product already exists on eBay ──────────

  const existingOfferId = inventoryItem.ebayOfferId;
  const existingListingId = inventoryItem.ebayListingId;
  const existingSyncHash = inventoryItem.ebaySyncHash;
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
    // Create new offer
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
          ebayMarketplaceId: ebayConfig.EBAY_MARKETPLACE_ID,
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
        ebayMarketplaceId: ebayConfig.EBAY_MARKETPLACE_ID,
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
};
