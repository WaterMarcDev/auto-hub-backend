/**
 * eBay Export Exclusion List
 *
 * Thin wrapper around the authoritative Wix exclusion logic so that
 * the eBay sync pipeline uses the exact same business rule. This file
 * does NOT duplicate the exclusion set — it delegates to
 * wixExportExclusions.isWixExcludedPart() unchanged.
 *
 * If the exclusion rule is ever updated (e.g. adding more excluded
 * part names), the single authoritative source in wixExportExclusions.js
 * is where the change goes — this file and its eBay consumers pick it up
 * automatically.
 */
const { isWixExcludedPart } = require("./wixExportExclusions");

/**
 * Checks whether an Inventory product is excluded from eBay publication.
 * Delegates to the existing case-insensitive rule targeting:
 *   windshield, a1, a2
 *
 * @param {Object} product - An Inventory document (must have a partName field)
 * @param {string} product.partName - The inventory part name to check
 * @returns {boolean} true if the product must be excluded from eBay sync
 */
function isEbayExcludedProduct(product) {
  if (!product || typeof product.partName !== "string") return false;
  return isWixExcludedPart(product.partName);
}

/**
 * Human-readable reason for the exclusion.
 * Returns null if the product is NOT excluded.
 *
 * @param {Object} product - An Inventory document
 * @returns {string|null}
 */
function ebayExclusionReason(product) {
  if (!product || typeof product.partName !== "string") return null;
  const name = String(product.partName).trim().toLowerCase();
  if (name === "a1") return "A1";
  if (name === "a2") return "A2";
  if (name === "windshield") return "Windshield";
  return null;
}

module.exports = {
  isEbayExcludedProduct,
  ebayExclusionReason,
};