/**
 * Canonical Product Identity (Year + Make + Model + Trim + Part + SKU + VIN)
 *
 * Single source of truth for turning a vehicle+part combination into a
 * stable, deterministic identity key used to decide whether two Inventory
 * records represent the SAME logical Wix product or two DIFFERENT ones.
 *
 * Historically (see controllers/wix.js's now-removed getGroupKey()), the
 * sync grouping key was YEAR+MAKE+MODEL+PART only — Trim was left out of
 * the identity even though Inventory.trim is a required field and the
 * product name/description already display it. That let two different
 * trims of the same Year+Make+Model (e.g. a 2012 BMW X5 xDrive35i and a
 * 2012 BMW X5 Base, both with a Front Bumper) collapse into ONE Wix
 * product group, silently losing one trim's identity. This module fixes
 * that by making Trim a first-class part of the identity, without
 * changing anything else about how identity segments are derived.
 *
 * Extracted from controllers/Inventory.controller.js's pre-existing
 * toTitleFromCamelCase() (moved here verbatim, not reimplemented) so the
 * exact same camelCase-splitting behavior already relied upon elsewhere
 * (e.g. Wix export descriptions/titles) is reused, not duplicated.
 */

/**
 * Splits a camelCase string into title-cased words, e.g. "frontBumper" ->
 * "Front Bumper". Moved verbatim from controllers/Inventory.controller.js
 * (same regexes, same behavior) — Inventory.controller.js now imports this
 * copy instead of defining its own, so there is exactly one implementation.
 */
function toTitleFromCamelCase(input) {
  if (typeof input !== "string") return "";
  return input
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Escapes regex metacharacters so a raw string can be used inside a RegExp safely. */
function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a case-insensitive, whole-string match query for a Mongoose
 * `name` field, e.g. { name: "toyota" } and { name: "TOYOTA" } both match
 * an existing "Toyota" document. Read-only helper — callers decide what to
 * do with the query (find vs findOne); this never mutates data.
 */
function buildCaseInsensitiveNameQuery(name) {
  return { name: new RegExp(`^${escapeRegExp(String(name || "").trim())}$`, "i") };
}

/**
 * Normalizes a proper-noun/code segment (Make, Model, Trim, Year) for use
 * inside a product identity key: lowercase, collapse whitespace/underscores
 * to a single hyphen, drop other punctuation, collapse/trim hyphens.
 * Deliberately does NOT split on internal case transitions — "xDrive35i"
 * is a manufacturer trim code, not two concatenated English words, and
 * must stay "xdrive35i", not become "x-drive35i".
 */
function normalizeIdentitySegment(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Normalizes a Part Name segment. Inventory.partName is stored as a
 * smashed camelCase value representing multiple English words (e.g.
 * "frontBumper" for "Front Bumper") — unlike Make/Model/Trim, this DOES
 * need camelCase splitting before normalization so "frontBumper",
 * "FrontBumper", "Front Bumper", "front-bumper", and "front_bumper" all
 * converge on the same identity segment ("front-bumper").
 */
function normalizePartNameSegment(partName) {
  const spaced = toTitleFromCamelCase(String(partName || ""));
  return normalizeIdentitySegment(spaced || partName);
}

/**
  * Builds the canonical product identity for a
 * Year+Make+Model+Trim+Part+SKU+VIN combination.
 *
 * Deterministic: the same logical inventory record always produces
 * the same key, regardless of casing/spacing/separator differences
 * in the source data.
 *
 * @param {Object} params
 * @param {string|number} params.year
 * @param {string} params.make
 * @param {string} params.model
 * @param {string} params.trim
 * @param {string} params.partName
 * @param {string} params.sku
 * @param {string} params.vin
 * @returns {{ key: string, segments: { year: string, make: string, model: string, trim: string, partName: string, sku: string, vin: string } }}
 */
function buildProductIdentity({ year, make, model, trim, partName, sku, vin }) {
  const segments = {
    year: normalizeIdentitySegment(year),
    make: normalizeIdentitySegment(make),
    model: normalizeIdentitySegment(model),
    trim: normalizeIdentitySegment(trim),
    partName: normalizePartNameSegment(partName),
    sku: normalizeIdentitySegment(sku), 
    vin: normalizeIdentitySegment(vin), 
  };

  const key = [segments.year, segments.make, segments.model, segments.trim, segments.partName, segments.sku, segments.vin,]
    .filter(Boolean)
    .join("-");

  return { key, segments };
}

module.exports = {
  toTitleFromCamelCase,
  escapeRegExp,
  buildCaseInsensitiveNameQuery,
  normalizeIdentitySegment,
  normalizePartNameSegment,
  buildProductIdentity,
};
