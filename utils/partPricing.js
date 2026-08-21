/**
 * Part Pricing (CSV-driven, Standard vs German)
 *
 * Single source of truth for per-part pricing during Wix Part Syncing.
 * Backed by assets/German_Cars_Price_List_20pct.csv — the business-supplied,
 * authoritative price list. No prices are hardcoded here; only the logic to
 * load, index, and look them up lives in this file.
 *
 * Loaded and indexed exactly once at module require() time (mirrors the
 * existing assets/part_prices.json pattern already used in controllers/wix.js)
 * so Part Syncing never re-reads/re-parses the CSV per item.
 */
const fs = require("fs");
const path = require("path");

const CSV_PATH = path.join(__dirname, "..", "assets", "German_Cars_Price_List_20pct.csv");

// Legacy flat price list (pre-existing, still required elsewhere via
// controllers/wix.js). Used here only as a fallback for a part that isn't
// one of the 49 rows in the new CSV, so no part regresses to "no price"
// just because the new list doesn't happen to cover it yet.
const LEGACY_PART_PRICES = require("../assets/part_prices.json");

/**
 * The exact camelCase key convention Inventory.partName is already stored
 * in (verified against the live Part catalog and real Inventory records):
 * split into words on any non-alphanumeric boundary, lowercase the first
 * word entirely, Title-case each subsequent word, concatenate.
 * e.g. "AC Compressor" -> "acCompressor", "Rear / Back Seat" -> "rearBackSeat".
 */
function toPartKey(name) {
  const words = String(name)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);

  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
}

// The CSV's "Part" column wording differs from the Part catalog's canonical
// name for these 9 rows (spelling variants, singular/plural, or a
// clarifying alias TikTok— none are business/pricing decisions, just
// naming). Each was verified by cross-referencing the CSV against the
// actual Part catalog (models/Part.model.js) and real Inventory.partName
// values already in the database:
//   - "Steering Rack & Pinion"  -> catalog "Steering"            (same assembly)
//   - "Windscreen (Windshield)" -> catalog "Wind Shield"
//   - "Coolant Bottle (Reservoir)" -> catalog "Coolant Reservoir"
//   - "Tyre"                    -> catalog "Tire"                (spelling)
//   - "Right Headlight"         -> catalog "Right Headlights"    (plural)
//   - "Left Headlight"          -> catalog "Left Headlights"     (plural)
//   - "Brake Disc (Rotor)"      -> catalog "Brake - Disk"        (spelling + synonym)
//   - "Heated Steering Wheel"   -> catalog "Heated Steering"
//   - "Trunk Gate / Liftgate / Tailgate" -> catalog "Trunk Gate" (first/canonical alternative)
//   - "Rear Windshield"         -> catalog "Rear Wind Shield"   (catalog spells this
//     entry as two words — "Wind Shield" — unlike "Heated Windshield", which the
//     catalog spells as one word; toPartKey() alone can't know which fused-vs-split
//     spelling the catalog used for a given entry, so this one is explicit)
// Every other CSV row matches the catalog automatically via toPartKey()
// once a trailing "(...)" clarification is stripped.
//
// UPDATE (2026-08-21, when the CSV was updated to add productType/category/
// image/description/title/slug columns): the CSV no longer has a row
// literally named "Windscreen (Windshield)" or "Rear Windshield" — it was
// reworded to "Heated Windshield" and "Heated Rear Windshield" respectively.
//
//   - "Heated Windshield" auto-resolves fine via toPartKey() ("heatedWindshield")
//     with no override needed — confirmed against a real Inventory.partName
//     of exactly "heatedWindshield" already in the database, a separate part
//     from "windShield" below (not a renaming of it).
//   - "Heated Rear Windshield" does NOT auto-resolve to the real catalog
//     name: toPartKey() derives "heatedRearWindshield", but the real,
//     existing Inventory.partName for this part is "rearWindShield" (capital
//     S, confirmed directly from the database — assets/part_prices.json's
//     "rearWindshield", lowercase, is a stale/unused key from an older
//     convention and was not the source of truth here). Its description
//     ("...with integrated defroster grid...") confirms this is the same
//     physical rear-windshield part the old "Rear Windshield" CSV row
//     priced, just reworded — not a new distinct part — so the override
//     below was added.
//   - "windShield" (plain/non-heated windscreen) is a real, separate,
//     still-existing Inventory.partName that the new CSV no longer prices
//     AT ALL (no "Windscreen"/plain-windshield row exists anymore, only the
//     "Heated" variant). Left WITHOUT an override deliberately: redirecting
//     it to "Heated Windshield"'s price would be a guess about whether a
//     plain windshield costs the same as a heated one, which could produce
//     an actively wrong price rather than a merely-missing one. This part
//     currently prices at $0 until the business adds it back to the CSV or
//     confirms it should map to "Heated Windshield".
const PART_NAME_KEY_OVERRIDES = {
  "Steering Rack & Pinion": "steering",
  "Windscreen (Windshield)": "windShield",
  "Coolant Bottle (Reservoir)": "coolantReservoir",
  "Tyre": "tire",
  "Right Headlight": "rightHeadlights",
  "Left Headlight": "leftHeadlights",
  "Brake Disc (Rotor)": "brakeDisk",
  "Heated Steering Wheel": "heatedSteering",
  "Trunk Gate / Liftgate / Tailgate": "trunkGate",
  "Rear Windshield": "rearWindShield",
  "Heated Rear Windshield": "rearWindShield",
};

function deriveCsvRowKey(rawPartName) {
  if (Object.prototype.hasOwnProperty.call(PART_NAME_KEY_OVERRIDES, rawPartName)) {
    return PART_NAME_KEY_OVERRIDES[rawPartName];
  }
  const withoutTrailingParenthetical = rawPartName.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return toPartKey(withoutTrailingParenthetical);
}

/**
 * Minimal, dependency-free CSV parser for this specific file's shape
 * (Part, Standard Price (USD), German Car Price (+20%), Source — no
 * quoted or embedded-comma fields). No new npm dependency is warranted
 * for a fixed, small, well-known 4-column file.
 */
function parseCsv(raw) {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rows = [];

  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const partName = (cols[0] || "").trim();
    if (!partName) continue;

    const standardPrice = Number(cols[1]);
    const germanPrice = Number(cols[2]);

    if (Number.isNaN(standardPrice) || Number.isNaN(germanPrice) || standardPrice < 0 || germanPrice < 0) {
      console.warn(`[PART_PRICING] Skipping CSV row with invalid price: "${partName}"`);
      continue;
    }

    rows.push({ partName, standardPrice, germanPrice });
  }

  return rows;
}

function buildPriceIndex() {
  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const rows = parseCsv(raw);
  const index = new Map();

  for (const row of rows) {
    const key = deriveCsvRowKey(row.partName);
    if (index.has(key)) {
      console.warn(
        `[PART_PRICING] Duplicate part key "${key}" — CSV rows "${index.get(key).partName}" and "${row.partName}" both resolve to it. Keeping the first.`
      );
      continue;
    }
    index.set(key, row);
  }

  return { rows, index };
}

// Loaded and indexed once at module load, not per Part Sync request/item.
const { rows: PRICE_LIST_ROWS, index: PRICE_INDEX } = buildPriceIndex();

/**
 * Resolve the correct sale price for a part.
 *
 * @param {Object} params
 * @param {string} params.partName - Inventory item's partName (already the
 *   camelCase key Inventory stores, e.g. "frontBumper")
 * @param {boolean} params.isGerman - Vehicle classification. Callers are
 *   responsible for determining this — see the classification gap noted in
 *   controllers/wix.js (isGermanVehicle()).
 * @returns {{ price: number, source: "csv"|"legacy-json"|"missing", matchedPartName?: string }}
 */
function resolvePartPrice({ partName, isGerman }) {
  if (!partName) {
    console.warn("[PRICE_MATCH_MISSING] No partName provided.");
    return { price: 0, source: "missing" };
  }

  const partKey = partName.replace(/\s+/g, "").replace(/^./, (c) => c.toLowerCase());
  const row = PRICE_INDEX.get(partKey);

  if (row) {
    const price = isGerman ? row.germanPrice : row.standardPrice;
    console.log(
      `[PRICE_MATCH_SUCCESS] part=${partKey} type=${isGerman ? "German" : "Standard"} price=${price} source=csv`
    );
    return { price, source: "csv", matchedPartName: row.partName };
  }

  if (Object.prototype.hasOwnProperty.call(LEGACY_PART_PRICES, partKey)) {
    const price = LEGACY_PART_PRICES[partKey];
    console.log(
      `[PRICE_MATCH_FALLBACK] part=${partKey} price=${price} source=legacy-json (not present in CSV)`
    );
    return { price, source: "legacy-json" };
  }

  console.warn(`[PRICE_MATCH_MISSING] part=${partKey} — no price found in CSV or legacy price list.`);
  return { price: 0, source: "missing" };
}

/** Read-only accessor for the full parsed CSV — e.g. for future diagnostics. */
function getAllPriceListRows() {
  return PRICE_LIST_ROWS;
}

module.exports = {
  resolvePartPrice,
  getAllPriceListRows,
  toPartKey,
  // Additive export only — same function already used internally to build
  // PRICE_INDEX. Exposed so other CSV-column consumers (e.g. the Wix sync
  // metadata reader) key their lookups identically to pricing, without a
  // second copy of the alias table drifting out of sync with this one.
  deriveCsvRowKey,
};
