/**
 * Wix Export Exclusion List
 *
 * These partName values are legitimate CRM Inventory parts (they remain in
 * Inventory, the internal inventory workflow, and MongoDB unchanged) but are
 * NOT real Wix-sellable products and must never appear in a Wix-bound
 * payload. This is a Wix-export-only boundary — it does not filter, hide,
 * or delete anything from Inventory itself.
 *
 * Comparison is case-insensitive: Inventory.partName is free-text set by
 * whatever casing the Add-to-Inventory workflow submitted (see
 * controllers/inventory.controller.js createInventory), so it is not
 * guaranteed to always be exactly "windShield"/"a1"/"a2".
 */
const WIX_EXCLUDED_PART_NAMES = new Set(["windshield", "a1", "a2"]);

function isWixExcludedPart(partName) {
  return WIX_EXCLUDED_PART_NAMES.has(String(partName || "").trim().toLowerCase());
}

module.exports = {
  WIX_EXCLUDED_PART_NAMES,
  isWixExcludedPart,
};
