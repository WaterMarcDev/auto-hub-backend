/**
 * Car Intake part exclusions
 *
 * Parts that must never be selected in a Car Intake's Step 3 (Car Diagnosis).
 * A1 (converter) and A2 (catalytic converter) are handled outside the parts
 * inventory, so they are always stored as not selected with 0 units —
 * whatever the client sends. Everything downstream that follows the
 * `selected` flag (Add To Inventory, scripts/bulkAddCarsToInventory.js,
 * the "part-added-to-inventory" completion check) then leaves them out.
 *
 * Keys are the Step 3 part keys ("a1", "a2"), matched case-insensitively.
 * This is intentionally separate from utils/wixExportExclusions.js, which
 * also lists Windshield — a real inventory part that stays selectable here.
 */
const INTAKE_DESELECTED_PARTS = new Set(["a1", "a2"]);

function isIntakeDeselectedPart(key) {
  return INTAKE_DESELECTED_PARTS.has(String(key || "").trim().toLowerCase());
}

/**
 * Returns a copy of a Step 3 parts object with every excluded part forced to
 * { selected: false, unit: 0 }. Other parts and non-object values are left
 * untouched; excluded parts that aren't present are not added.
 */
function applyIntakePartExclusions(parts) {
  if (!parts || typeof parts !== "object" || Array.isArray(parts)) return parts;

  const result = { ...parts };

  for (const key of Object.keys(result)) {
    if (!isIntakeDeselectedPart(key)) continue;

    const value = result[key];
    const base = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    result[key] = { ...base, selected: false, unit: 0 };
  }

  return result;
}

module.exports = {
  INTAKE_DESELECTED_PARTS,
  isIntakeDeselectedPart,
  applyIntakePartExclusions,
};
