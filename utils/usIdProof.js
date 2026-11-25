/**
 * US ID proof types and the format of each one's number.
 * Mirrors auto-hub-frontend/src/utils/usIdProof.js.
 *
 * Driver's license / state ID numbers differ by state: 4–15 letters and
 * digits covers every state (New Jersey is 1 letter + 14 digits = 15).
 */
const US_ID_PROOF_PATTERNS = {
  "Driver's License": /^[A-Z0-9]{4,15}$/,
  "State ID": /^[A-Z0-9]{4,15}$/,
  "US Passport": /^([0-9]{9}|[A-Z][0-9]{8})$/,
  "US Passport Card": /^C[0-9]{8}$/,
  "Permanent Resident Card": /^[A-Z]{3}[0-9]{10}$/,
  "Military ID": /^[0-9]{10}$/,
};

// Upper-case and drop spaces / dashes.
const normalizeIdProofNumber = (value) =>
  String(value ?? "").toUpperCase().replace(/[\s-]+/g, "");

/**
 * Error message for an invalid type / number pair, or null when valid.
 * Both are optional, but a number needs a known type and must match it.
 */
function idProofError(type, number) {
  const num = normalizeIdProofNumber(number);
  if (!type && !num) return null;
  const pattern = US_ID_PROOF_PATTERNS[type];
  if (!pattern) return "ID Proof Type must be one of: " + Object.keys(US_ID_PROOF_PATTERNS).join(", ");
  if (num && !pattern.test(num)) return `Invalid ${type} number`;
  return null;
}

module.exports = { US_ID_PROOF_PATTERNS, normalizeIdProofNumber, idProofError };
