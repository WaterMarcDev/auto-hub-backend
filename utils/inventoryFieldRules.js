// Field rules for inventory parts, the parts catalog and in-store sales.
// Shared by inventory.controller.js, part.controller.js and
// inventorySync.controller.js so the server always answers 400 (never 500)
// for bad input. The frontend applies the same limits.

const MAX_PART_WEIGHT = 15000; // lb, for one part
// "12", "12.5", "12.", ".5" (what a number box can send); max 2 decimals.
const WEIGHT_PATTERN = /^(\d{1,5}(\.\d{0,2})?|\.\d{1,2})$/;
// 17 characters, letters and digits, never I, O or Q.
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;
const MAX_SALE_PRICE = 2000;
const PRICE_PATTERN = /^(\d{1,7}(\.\d{0,2})?|\.\d{1,2})$/;
// Letters (any language), spaces and . ' - , &
const PERSON_NAME_PATTERN = /^[\p{L}][\p{L} .'\-,&]*$/u;

const TEXT_LIMITS = {
  partName: 100,
  location: 100,
  dimensions: 100,
  color: 50,
  quality: 50,
  vehicleName: 100, // make / model / trim typed for "Other" parts
  buyerName: 100,
  saleNote: 500,
  adjustReason: 500,
  shortName: 20,
};

const isBlank = (v) => v === undefined || v === null || String(v).trim() === "";

// Optional text: trimmed; blank / spaces only -> undefined.
// Returns { value } or { error }.
function optionalText(value, label, max) {
  if (isBlank(value)) return { value: undefined };
  if (typeof value !== "string" && typeof value !== "number") {
    return { error: `${label} must be text` };
  }
  const text = String(value).trim().replace(/\s+/g, " ");
  if (text.length > max) return { error: `${label} must be at most ${max} characters` };
  return { value: text };
}

// Optional weight: 0 - 15,000 with up to 2 decimals. Blank -> undefined.
function parseWeight(value, label = "Weight") {
  if (isBlank(value)) return { value: undefined };
  const text = String(value).trim();
  if (typeof value === "object" || !WEIGHT_PATTERN.test(text)) {
    return {
      error: `${label} must be a number from 0 to ${MAX_PART_WEIGHT.toLocaleString("en-US")} with up to 2 decimals (no units or letters)`,
    };
  }
  const n = Number(text);
  if (n > MAX_PART_WEIGHT) {
    return { error: `${label} cannot be more than ${MAX_PART_WEIGHT.toLocaleString("en-US")}` };
  }
  return { value: n };
}

// Optional VIN: 17 letters/digits without I, O, Q. Upper-cased.
function parseVin(value) {
  if (isBlank(value)) return { value: undefined };
  const vin = String(value).trim().toUpperCase();
  if (!VIN_PATTERN.test(vin)) {
    return { error: "VIN must be exactly 17 letters and digits (I, O and Q are not allowed)" };
  }
  return { value: vin };
}

// Optional model year: whole number from 1900 to the current year (no
// future years).
function parseYear(value) {
  if (isBlank(value)) return { value: undefined };
  const max = new Date().getFullYear();
  const text = String(value).trim();
  if (!/^\d{4}$/.test(text) || Number(text) < 1900 || Number(text) > max) {
    return { error: `Year must be a 4-digit year between 1900 and ${max}` };
  }
  return { value: Number(text) };
}

// Optional color: max 50, letters (any language), spaces and hyphens,
// starting with a letter. Blank / spaces only -> undefined.
const COLOR_PATTERN = /^\p{L}[\p{L} -]*$/u;
function parseColor(value, label = "Color", max = TEXT_LIMITS.color) {
  const r = optionalText(value, label, max);
  if (r.error || r.value === undefined) return r;
  if (!COLOR_PATTERN.test(r.value)) {
    return { error: `${label} can contain only letters, spaces and hyphens (-)` };
  }
  return r;
}

// Optional sale price: 0 - 2,000 with up to 2 decimals.
function parsePrice(value) {
  if (isBlank(value)) return { value: undefined };
  const text = String(value).trim();
  if (typeof value === "object" || !PRICE_PATTERN.test(text) || Number(text) > MAX_SALE_PRICE) {
    return {
      error: `Sale price must be a number from 0 to ${MAX_SALE_PRICE.toLocaleString("en-US")} with up to 2 decimals`,
    };
  }
  return { value: Number(text) };
}

// Optional person name (buyer): letters, spaces and . ' - , &
function parsePersonName(value, label = "Buyer name", max = TEXT_LIMITS.buyerName) {
  const r = optionalText(value, label, max);
  if (r.error || r.value === undefined) return r;
  if (!PERSON_NAME_PATTERN.test(r.value)) {
    return { error: `${label} can contain only letters, spaces and . ' - , &` };
  }
  return r;
}

// Mongoose validation / cast problems are bad input, not server errors.
function isInputError(err) {
  return Boolean(err && (err.name === "ValidationError" || err.name === "CastError"));
}

module.exports = {
  MAX_PART_WEIGHT,
  MAX_SALE_PRICE,
  TEXT_LIMITS,
  VIN_PATTERN,
  isBlank,
  optionalText,
  parseWeight,
  parseVin,
  parseYear,
  parseColor,
  parsePrice,
  parsePersonName,
  isInputError,
};
