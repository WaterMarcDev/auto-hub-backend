/**
 * eBay Catalog Configuration
 *
 * Centralized configuration-driven settings for the eBay catalog
 * synchronization pipeline. All values come from environment variables
 * or from verified mapping tables — nothing is fabricated.
 *
 * Before any publish operation, isCatalogConfigured() must return true.
 */
const path = require("path");

// ─── Marketplace & Environment ───────────────────────────────────────────────

const EBAY_MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";

// FAIL CLOSED: EBAY_ENVIRONMENT must be explicitly "production" or
// "sandbox" (case/whitespace-insensitive). A missing or unrecognized value
// resolves to null — it must NEVER silently default to "production". null
// is picked up by isCatalogConfigured()/getMissingConfiguration() below, so
// an ambiguous environment blocks publishing exactly like a missing
// category/policy/location does, before any eBay API call is attempted.
const VALID_EBAY_ENVIRONMENTS = ["production", "sandbox"];
const RAW_EBAY_ENVIRONMENT = (process.env.EBAY_ENVIRONMENT || "").toLowerCase().trim();
const EBAY_ENVIRONMENT = VALID_EBAY_ENVIRONMENTS.includes(RAW_EBAY_ENVIRONMENT) ? RAW_EBAY_ENVIRONMENT : null;

// ─── Merchant Location ──────────────────────────────────────────────────────

const EBAY_MERCHANT_LOCATION_KEY = process.env.EBAY_MERCHANT_LOCATION_KEY || null;
// ─── Sync Performance ───────────────────────────────────────────────────────

const EBAY_SYNC_CONCURRENCY = parseInt(process.env.EBAY_SYNC_CONCURRENCY || "3", 10);
const EBAY_SYNC_BATCH_SIZE = parseInt(process.env.EBAY_SYNC_BATCH_SIZE || "25", 10);

/** Safety limit: 0 = allow full catalog sync. */
const EBAY_SYNC_MAX_PRODUCTS = parseInt(process.env.EBAY_SYNC_MAX_PRODUCTS || "0", 10) || 0;

/** Max run duration before lock considered stale (default 4 hours). */
const EBAY_SYNC_MAX_RUN_DURATION_MS =
  parseInt(process.env.EBAY_SYNC_MAX_RUN_DURATION_MS || String(4 * 60 * 60 * 1000), 10);

// ─── Category Mapping (START EMPTY — populate with verified IDs) ────────────

/**
 * CRM partName (camelCase) → eBay leaf category ID mapping.
 *
 * THIS MAP STARTS EMPTY. No category IDs are fabricated.
 * Any product without a mapping will fail with CATEGORY_ERROR.
 *
 * To find correct eBay category IDs, use the Taxonomy API or
 * Seller Hub category structure.
 *
 * Example:
 *   const PART_CATEGORY_TO_EBAY_CATEGORY = {
 *     "acCompressor": 12345,
 *     "alternator": 12346,
 *     "frontBumper": 12347,
 *   };
 */
const PART_CATEGORY_TO_EBAY_CATEGORY = {};

// ─── Business Policies (from eBay Seller Hub) ────────────────────────────────

const EBAY_PAYMENT_POLICY_ID = process.env.EBAY_PAYMENT_POLICY_ID || null;
const EBAY_RETURN_POLICY_ID = process.env.EBAY_RETURN_POLICY_ID || null;
const EBAY_FULFILLMENT_POLICY_ID = process.env.EBAY_FULFILLMENT_POLICY_ID || null;

// ─── Listing Defaults ────────────────────────────────────────────────────────

const EBAY_LISTING_FORMAT = process.env.EBAY_LISTING_FORMAT || "FIXED_PRICE";
const EBAY_LISTING_DURATION = process.env.EBAY_LISTING_DURATION || "GTC";

/** Default condition for used auto parts (must be valid for chosen category). */
const EBAY_DEFAULT_CONDITION = process.env.EBAY_DEFAULT_CONDITION || "USED_GOOD";

const EBAY_DEFAULT_CONDITION_DESCRIPTION =
  process.env.EBAY_DEFAULT_CONDITION_DESCRIPTION ||
  "Used, good condition. Pulled from a salvaged vehicle, tested before removal.";
/**
 * Returns true only when ALL required eBay configuration values are present.
 */
function isCatalogConfigured() {
  const hasCategories = Object.keys(PART_CATEGORY_TO_EBAY_CATEGORY).length > 0;
  const hasPolicies = Boolean(EBAY_PAYMENT_POLICY_ID) && Boolean(EBAY_RETURN_POLICY_ID) && Boolean(EBAY_FULFILLMENT_POLICY_ID);
  const hasLocation = Boolean(EBAY_MERCHANT_LOCATION_KEY);
  const hasValidEnvironment = EBAY_ENVIRONMENT !== null;
  return hasCategories && hasPolicies && hasLocation && hasValidEnvironment;
}

/**
 * Returns an array of missing configuration keys (human-readable).
 */
function getMissingConfiguration() {
  const missing = [];
  if (EBAY_ENVIRONMENT === null) {
    missing.push(`EBAY_ENVIRONMENT (must be exactly "production" or "sandbox" — currently ${process.env.EBAY_ENVIRONMENT ? `invalid: "${process.env.EBAY_ENVIRONMENT}"` : "missing"})`);
  }
  if (Object.keys(PART_CATEGORY_TO_EBAY_CATEGORY).length === 0) {
    missing.push("eBay category mappings (PART_CATEGORY_TO_EBAY_CATEGORY in config/ebayCatalogConfig.js)");
  }
  if (!EBAY_PAYMENT_POLICY_ID) missing.push("EBAY_PAYMENT_POLICY_ID");
  if (!EBAY_RETURN_POLICY_ID) missing.push("EBAY_RETURN_POLICY_ID");
  if (!EBAY_FULFILLMENT_POLICY_ID) missing.push("EBAY_FULFILLMENT_POLICY_ID");
  if (!EBAY_MERCHANT_LOCATION_KEY) missing.push("EBAY_MERCHANT_LOCATION_KEY");
  return missing;
}

/**
 * Look up eBay category ID for a part name.
 * @param {string} partName - CamelCase part name (e.g. "frontBumper")
 * @returns {string|null} eBay leaf category ID or null if unmapped
 */
function lookupEbayCategoryId(partName) {
  if (!partName) return null;
  const key = partName.replace(/\s+/g, "").replace(/^./, (c) => c.toLowerCase());
  return PART_CATEGORY_TO_EBAY_CATEGORY[key] || null;
}

// ─── Export ──────────────────────────────────────────────────────────────────

module.exports = {
  EBAY_MARKETPLACE_ID,
  EBAY_ENVIRONMENT,
  EBAY_MERCHANT_LOCATION_KEY,
  EBAY_PAYMENT_POLICY_ID,
  EBAY_RETURN_POLICY_ID,
  EBAY_FULFILLMENT_POLICY_ID,
  EBAY_LISTING_FORMAT,
  EBAY_LISTING_DURATION,
  EBAY_DEFAULT_CONDITION,
  EBAY_DEFAULT_CONDITION_DESCRIPTION,
  EBAY_SYNC_CONCURRENCY,
  EBAY_SYNC_BATCH_SIZE,
  EBAY_SYNC_MAX_PRODUCTS,
  EBAY_SYNC_MAX_RUN_DURATION_MS,
  PART_CATEGORY_TO_EBAY_CATEGORY,
  isCatalogConfigured,
  getMissingConfiguration,
  lookupEbayCategoryId,
};