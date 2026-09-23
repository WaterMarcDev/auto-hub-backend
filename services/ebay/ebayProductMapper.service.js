/**
 * eBay Product Mapper - Converts CRM Inventory to eBay payloads.
 * Applies exclusions, validation, category mapping, pricing, metadata,
 * and generates a sync hash for change detection.
 */
const crypto = require("crypto");
const ebayConfig = require("../../config/ebayCatalogConfig");
const { isEbayExcludedProduct, ebayExclusionReason } = require("../../utils/ebayExportExclusions");
const { resolvePartPrice } = require("../../utils/partPricing");
const { resolvePartMetadata, resolveTemplate, splitImageUrls } = require("../../utils/partSyncMetadata");
const { isGermanVehicle } = require("../../utils/vehicleClassification");
const { toTitleFromCamelCase } = require("../../utils/productIdentity");

const VALID_CONDITIONS = new Set([
  "NEW", "LIKE_NEW", "NEW_OTHER",
  "USED_VERY_GOOD", "USED_GOOD", "USED_ACCEPTABLE",
  "FOR_PARTS_OR_NOT_WORKING",
]);

// "Placement on Vehicle" — explicit whitelist, not a name-pattern heuristic.
// Each value string uses the exact wording observed as a real "Placement on
// Vehicle" filter facet on eBay's own category-browse pages during this
// audit (e.g. ebay.com/b/Car-Truck-Doors-Door-Skins/179850 exposes
// Front/Rear/Left/Right/Front Left/Front Right/Rear Left/Rear Right facets;
// ebay.com/b/Car-Truck-Fenders/33644 exposes Front/Left/Rear/Right). Only
// keys with directly-observed facet evidence for their mapped category are
// listed — everything else (chassis, heatedSideMirrors, seats, etc.) is
// deliberately absent rather than guessed. See ebayProductMapper.service.js Phase
// 8a-pre for how this is used (additive/recommended, never a hard
// requirement).
const PLACEMENT_ON_VEHICLE_BY_PART = {
  // Doors — category 179850, facet evidence includes compound Front/Rear + Left/Right values
  frontLeftDoor: "Front Left",
  frontRightDoor: "Front Right",
  rearLeftDoor: "Rear Left",
  rearRightDoor: "Rear Right",
  // Headlights — category 33710, facet evidence: Front/Left/Right (no compound observed)
  leftHeadlights: "Left",
  rightHeadlights: "Right",
  // Fenders — category 33644, facet evidence: Front/Left/Rear/Right
  leftFender: "Left",
  rightFender: "Right",
  // Bumpers — category 33640, facet evidence includes a distinct "Rear ...
  // Bumpers" sub-listing (front is the unqualified default sub-listing)
  frontBumper: "Front",
  rearBumper: "Rear",
  // Mirror assemblies — category 262161, facet evidence: distinct Left/
  // Right sub-listings confirmed, though less exhaustively than the above
  rightSideMirror: "Right",
  leftSideMirror: "Left",
};

function mapProduct(item, options) {
  options = options || {};
  var r = {
    status: null, reason: null, sku: null, ebayCategoryId: null,
    inventoryItemPayload: null, offerPayload: null, compatibilityPayload: null, syncHash: null, errors: [], warnings: []
  };

  // Phase 1: Exclusion BEFORE any mapping or API call
  if (isEbayExcludedProduct(item)) {
    r.status = "EXCLUDED"; r.reason = ebayExclusionReason(item);
    r.errors.push("Excluded: " + r.reason); return r;
  }

  // Phase 2: Required fields
  r.sku = String(item._id);
  var makeName = (item.make && item.make.name) || item.makeName || "";
  var modelName = (item.model && item.model.name) || item.modelName || "";
  var trimName = (item.trim && item.trim.name) || item.trimName || "";
  var year = item.year || "";
  var partName = item.partName || "";
  if (!partName) { r.status = "FAILED"; r.reason = "VALIDATION_ERROR"; r.errors.push("Missing partName"); return r; }

  // Phase 3: Product identity and title
  // Built from filtered, non-empty segments only (not naive concatenation)
  // so a missing year/trim/etc. never leaves double spaces or a dangling
  // separator in the title (e.g. "BMW  - Front Bumper" if trim is blank).
  var formattedPartName = toTitleFromCamelCase(partName);
  var vehicleTitleSegments = [year, makeName, modelName, trimName].filter(function (s) { return s !== undefined && s !== null && String(s).trim() !== ""; });
  var productTitle = (vehicleTitleSegments.join(" ") + " - " + formattedPartName).trim();

  // Phase 4: Category mapping
  var ebayCategoryId = ebayConfig.lookupEbayCategoryId(partName);
  if (!ebayCategoryId) { r.status = "FAILED"; r.reason = "CATEGORY_ERROR"; r.errors.push("No eBay category for " + partName); return r; }
  r.ebayCategoryId = ebayCategoryId;

  // Phase 5: Condition
  var condition = ebayConfig.EBAY_DEFAULT_CONDITION;
  if (!VALID_CONDITIONS.has(condition)) { r.status = "FAILED"; r.reason = "VALIDATION_ERROR"; r.errors.push("Invalid condition"); return r; }

  // Phase 6: Pricing
  var isGerman = isGermanVehicle(makeName);
  var priceObj = resolvePartPrice({ partName: partName, isGerman: isGerman });
  var price = priceObj.price;
  if (!price || price <= 0) { r.status = "FAILED"; r.reason = "VALIDATION_ERROR"; r.errors.push("Invalid price"); return r; }

  // Phase 7: Metadata (description, images)
  var meta = resolvePartMetadata({ partName: partName });
  var desc = resolveTemplate(meta.descriptionTemplate || "", { year: year, make: makeName, model: modelName })
    || (productTitle + " - Used condition OEM part.");
  var imageUrls = [];
  if (item.image) { imageUrls.push(item.image); }
  else if (meta.productImageUrl) { imageUrls = splitImageUrls(meta.productImageUrl); }

  imageUrls = imageUrls.filter(function (u) {
    if (!u) return false;
    try { var p = new URL(u); return p.protocol === "https:" || p.protocol === "http:"; }
    catch (e) { return false; }
  });

  if (imageUrls.length === 0) {
    r.status = "FAILED";
    r.reason = "NO_IMAGES";
    r.errors.push("At least one valid image URL is required for eBay publishing");
    return r;
  }

  // Phase 8: Inventory Item payload
  // Brand note: the CRM Inventory schema has no separate "part manufacturer"
  // field distinct from the vehicle Make (see models/Inventory.model.js —
  // only `make`/`model`/`trim`/`year` exist). We deliberately do NOT fabricate
  // a third-party brand. Every synced product is a used, genuine/OEM part
  // pulled directly from that vehicle, so the vehicle Make IS the correct
  // eBay "Brand" for this category of listing (standard practice for used
  // OEM auto parts). This is a documented design decision, not an oversight.
  var invPayload = {
    availability: { shipToLocationAvailability: { quantity: 1 } },
    condition: condition,
    conditionDescription: ebayConfig.EBAY_DEFAULT_CONDITION_DESCRIPTION,
    product: {
      title: productTitle.length > 80 ? productTitle.substring(0, 80) : productTitle,
      description: desc, brand: makeName || "Unknown",
      // No genuine manufacturer part number exists anywhere in the CRM
      // (verified: Inventory.sku is a CRM-generated composite descriptive
      // code — `${makeShort}/${modelShort}/${year}-${partShort}/${color}`,
      // see controllers/inventory.controller.js — not unique per physical
      // item and not sourced from any manufacturer). "Does Not Apply" is
      // eBay's own standard, honest Item Specifics value for exactly this
      // situation — it is not a fabricated part number, unlike sending
      // item.sku as if it were one.
      mpn: "Does Not Apply",
      imageUrls: imageUrls.slice(0, 24),
      aspects: { "Part Name": [formattedPartName] },
    },
  };
  if (makeName) invPayload.product.aspects["Brand"] = [makeName];
  if (year) invPayload.product.aspects["Year"] = [String(year)];
  if (modelName) invPayload.product.aspects["Model"] = [modelName];

  // Phase 8a-pre: "Placement on Vehicle" — a RECOMMENDED, non-blocking
  // aspect, added opportunistically where the CRM part name genuinely
  // encodes a real position AND eBay's own category-browse pages were
  // directly observed to expose "Placement on Vehicle" as a real facet for
  // that category (doors/179850, headlights/33710, fenders/33644,
  // bumpers/33640, mirror assemblies/262161 — evidenced against live
  // eBay.com category pages during this audit, not invented).
  //
  // Deliberately NOT added to CATEGORY_SPECIFICS_REQUIREMENTS: a filter
  // facet existing on eBay's own browse UI proves sellers commonly USE this
  // aspect for these categories, but does NOT prove eBay's publish-time
  // validation actually REQUIRES it (that needs the Taxonomy API's
  // GetItemAspectsForCategory aspectUsage=REQUIRED flag, not available in
  // this environment). Making it a hard requirement without that evidence
  // would itself be inventing a requirement — exactly what this audit must
  // not do. So: populate it when we genuinely know it (pure enrichment,
  // never blocks a sync), and never invent a value for a key not in this
  // explicit whitelist (e.g. "chassis", "heatedSideMirrors" — ambiguous —
  // are deliberately absent below, not guessed).
  var placement = PLACEMENT_ON_VEHICLE_BY_PART[partName];
  if (placement) invPayload.product.aspects["Placement on Vehicle"] = [placement];

  // Phase 8a: Category-specific required Item Specifics. The generic
  // aspect set above (Part Name/Brand/Year/Model) is not guaranteed
  // sufficient for every eBay category — see
  // config/ebayCatalogConfig.js#CATEGORY_SPECIFICS_REQUIREMENTS. That map
  // starts empty (no category requirement is fabricated), so this is a
  // complete no-op today for every category; it only ever fails a product
  // once a real, verified per-category requirement is added and this
  // product's CRM-derived aspects don't satisfy it — failing here, before
  // any API call, rather than sending an incomplete listing to eBay.
  var requiredAspects = ebayConfig.getRequiredAspectsForCategory(ebayCategoryId);
  var missingAspects = requiredAspects.filter(function (name) {
    var value = invPayload.product.aspects[name];
    return !value || (Array.isArray(value) && value.length === 0) || !String(value[0] || "").trim();
  });
  if (missingAspects.length > 0) {
    r.status = "FAILED";
    r.reason = "ITEM_SPECIFICS_ERROR";
    r.errors.push("Missing required item specifics for category " + ebayCategoryId + ": " + missingAspects.join(", "));
    return r;
  }

  // Phase 8b: Vehicle fitment (Year/Make/Model/Trim compatibility).
  // Built independently of the title/description — those are NOT proof of
  // fitment; eBay's actual compatibility data comes only from the separate
  // Product Compatibility API (see ebayCatalogSync.service.js's call to
  // createOrReplaceProductCompatibility). Year is schema-optional on
  // Inventory (unlike make/model/trim), so a missing year makes accurate
  // fitment data impossible — publish still proceeds (year is a legitimate,
  // if rare, real-world gap), but it's surfaced as a warning rather than
  // silently omitted.
  var compatibilityPayload = null;
  if (year && makeName && modelName) {
    // Motors (Trading API) categories only: do not send ItemCompatibilityList
    // built from raw, unverified CRM Year/Make/Model/Trim unless this
    // specific category has verified eBay-valid compatibility data (see
    // config/ebayCatalogConfig.js#isCompatibilityVerifiedForCategory and its
    // module doc for the exact evidence — eBay error 21917122, "All
    // compatibilities are invalid", confirmed for category 36474 with this
    // exact kind of data). The REST Product Compatibility API path (any
    // non-Motors category, e.g. 33701) is NOT affected by this check — it
    // keeps sending the same data it always has, unchanged, since that path
    // has proven, live-verified working compatibility today.
    var isMotorsProductForCompat = ebayConfig.isMotorsCategory(ebayCategoryId);
    var compatibilityAllowed = !isMotorsProductForCompat || ebayConfig.isCompatibilityVerifiedForCategory(ebayCategoryId);

    if (compatibilityAllowed) {
      var compatibilityProperties = [
        { name: "Year", value: String(year) },
        { name: "Make", value: makeName },
        { name: "Model", value: modelName },
      ];
      if (trimName) compatibilityProperties.push({ name: "Trim", value: trimName });
      compatibilityPayload = { compatibleProducts: [{ compatibilityProperties: compatibilityProperties }] };
    } else {
      r.warnings.push(
        "Compatibility omitted for category " + ebayCategoryId +
        ": Motors category has no eBay-verified compatibility values (CRM Year/Make/Model/Trim cannot be assumed valid — see eBay error 21917122). Listing will publish without vehicle fitment."
      );
    }
  } else {
    r.warnings.push("Incomplete Year/Make/Model — publishing WITHOUT vehicle fitment/compatibility data");
  }

  // Phase 9: Offer payload
  const offerPayload = {
    sku: r.sku,
    // REST Inventory API marketplace — deliberately EBAY_REST_MARKETPLACE_ID,
    // NOT the shared EBAY_MARKETPLACE_ID (which is EBAY_MOTORS_US in
    // production, a value the REST API rejects: HTTP 400 errorId 2004
    // "Could not serialize field [marketplaceId]", confirmed via production
    // evidence for SKU 6a671fa7a90038bf08da0649 / category 36474). This
    // offerPayload is only ever read by the REST path (syncProduct) — the
    // Motors Trading API path (syncMotorsProduct) builds its own XML from
    // separate fields and never reads offerPayload.marketplaceId.
    marketplaceId: ebayConfig.EBAY_REST_MARKETPLACE_ID,
    format: ebayConfig.EBAY_LISTING_FORMAT,
    listingDuration: ebayConfig.EBAY_LISTING_DURATION,

    availableQuantity: 1,

    categoryId: ebayCategoryId,

    listingDescription: desc,

    merchantLocationKey:
      ebayConfig.EBAY_MERCHANT_LOCATION_KEY,

    listingPolicies: {
      paymentPolicyId:
        ebayConfig.EBAY_PAYMENT_POLICY_ID,

      returnPolicyId:
        ebayConfig.EBAY_RETURN_POLICY_ID,

      fulfillmentPolicyId:
        ebayConfig.EBAY_FULFILLMENT_POLICY_ID,
    },

    pricingSummary: {
      price: {
        currency: "USD",
        value: String(price),
      },
    },
  };
  var missing = [];
  // Fail closed on an ambiguous environment at this same pre-flight,
  // zero-API-calls point — never let a missing/invalid EBAY_ENVIRONMENT
  // reach an actual eBay API call by silently assuming production.
  if (!ebayConfig.EBAY_ENVIRONMENT) missing.push("EBAY_ENVIRONMENT (must be exactly \"production\" or \"sandbox\")");
  if (!offerPayload.listingPolicies.paymentPolicyId) missing.push("EBAY_PAYMENT_POLICY_ID");
  // EBAY_RETURN_POLICY_ID is a REST/Inventory-API-only concept —
  // offerPayload.listingPolicies.returnPolicyId is never read by the Motors
  // Trading API path (see syncMotorsProduct() in ebayCatalogSync.service.js,
  // which uses the separate, independently-optional
  // EBAY_MOTORS_RETURN_PROFILE_ID instead, already handled in that file's
  // buildMotorsItemFieldsXml). Requiring the REST policy for a Motors
  // product here was an architectural inconsistency — Motors could be
  // blocked by a policy it never actually consumes. Only enforced for
  // non-Motors (REST) products; REST behavior is completely unchanged.
  var isMotorsProduct = ebayConfig.isMotorsCategory(ebayCategoryId);
  if (!isMotorsProduct && !offerPayload.listingPolicies.returnPolicyId) missing.push("EBAY_RETURN_POLICY_ID");
  if (!offerPayload.listingPolicies.fulfillmentPolicyId) missing.push("EBAY_FULFILLMENT_POLICY_ID");
  if (!offerPayload.merchantLocationKey) missing.push("EBAY_MERCHANT_LOCATION_KEY");
  if (missing.length > 0) { r.status = "FAILED"; r.reason = "POLICY_CONFIGURATION_ERROR"; r.errors.push("Missing: " + missing.join(", ")); return r; }

  // Phase 10: Sync hash (includes fitment so a Year/Make/Model/Trim change
  // on the Inventory record — e.g. a data-entry correction — triggers a
  // resync, not just a price/description/category change). imageUrls MUST
  // be included — a caught-by-integration-test bug previously omitted it,
  // meaning an image-only change (e.g. a better photo swapped in) was
  // silently treated as "unchanged" and never resynced to eBay.
  var hashInput = [productTitle, desc, String(price), condition, ebayCategoryId, makeName, item.sku || "", JSON.stringify(compatibilityPayload), imageUrls.join(",")].join("|||");
  r.syncHash = crypto.createHash("sha256").update(hashInput, "utf8").digest("hex");

  r.status = "MAPPED";
  r.inventoryItemPayload = invPayload;
  r.offerPayload = offerPayload;
  r.compatibilityPayload = compatibilityPayload;
  return r;
}

module.exports = { mapProduct: mapProduct, VALID_CONDITIONS: VALID_CONDITIONS };