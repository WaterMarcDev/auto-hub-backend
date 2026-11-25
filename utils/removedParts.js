/**
 * Parts removed from the CRM
 *
 * A1, A2, Windshield, Heated Windshield and Heated Rear Windshield are no longer used anywhere in the
 * CRM: they are hidden from the Part catalog (so Car Intake Step 3 and the
 * "Add Part" pickers no longer offer them) and from the Master Parts list.
 * Existing records are cleaned up by scripts/removeDiscontinuedParts.js.
 *
 * Names are compared after lower-casing and dropping everything that is not a
 * letter or digit, so "Heated Windshield", "heatedWindshield", "windShield",
 * "Wind Shield" and "Windscreen (Windshield)" all match. The plain Rear
 * Windshield is NOT removed ("rearWindShield" stays).
 */
const REMOVED_PART_KEYS = new Set([
  "a1",
  "a2",
  "windshield",
  "windscreen",
  "windscreenwindshield",
  "heatedwindshield",
  "heatedrearwindshield",
]);

const compactPartName = (name) =>
  String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function isRemovedPart(name) {
  return REMOVED_PART_KEYS.has(compactPartName(name));
}

// Mongo regexes that match the same names (optional spaces, "_" or "-"
// between words, any case). Use with $nor on a part-name field.
const REMOVED_PART_NAME_REGEXES = [
  /^\s*A[\s_-]*1\s*$/i,
  /^\s*A[\s_-]*2\s*$/i,
  /^\s*Wind[\s_-]*shield\s*$/i,
  /^\s*Wind[\s_-]*screen\s*$/i,
  /^\s*Wind[\s_-]*screen\s*\(\s*Wind[\s_-]*shield\s*\)\s*$/i,
  /^\s*Heated[\s_-]*Wind[\s_-]*shield\s*$/i,
  /^\s*Heated[\s_-]*Rear[\s_-]*Wind[\s_-]*shield\s*$/i,
];

// { $nor: [...] } clause for a given field, e.g. removedPartsNor("partName").
const removedPartsNor = (field) =>
  REMOVED_PART_NAME_REGEXES.map((re) => ({ [field]: re }));

module.exports = {
  REMOVED_PART_KEYS,
  REMOVED_PART_NAME_REGEXES,
  compactPartName,
  isRemovedPart,
  removedPartsNor,
};
