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
      // see controllers/Inventory.controller.js — not unique per physical
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
    var compatibilityProperties = [
      { name: "Year", value: String(year) },
      { name: "Make", value: makeName },
      { name: "Model", value: modelName },
    ];
    if (trimName) compatibilityProperties.push({ name: "Trim", value: trimName });
    compatibilityPayload = { compatibleProducts: [{ compatibilityProperties: compatibilityProperties }] };
  } else {
    r.warnings.push("Incomplete Year/Make/Model — publishing WITHOUT vehicle fitment/compatibility data");
  }

  // Phase 9: Offer payload
  const offerPayload = {
    sku: r.sku,
    marketplaceId: ebayConfig.EBAY_MARKETPLACE_ID,
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
  if (!offerPayload.listingPolicies.returnPolicyId) missing.push("EBAY_RETURN_POLICY_ID");
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