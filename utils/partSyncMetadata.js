/**
 * Part Sync Metadata (CSV-driven: description/title/image/slug/category/productType)
 *
 * Reads the SAME CSV as utils/partPricing.js (assets/German_Cars_Price_List_20pct.csv)
 * but is otherwise fully independent of it — this file does not touch price
 * fields, does not modify PART_NAME_KEY_OVERRIDES, and does not change any
 * pricing behavior. It exists only because the non-price columns
 * (descriptionTemplate, titleTemplate, handleIdSlug, brand_placeholder,
 * productImageUrl) can contain commas inside quoted CSV fields, which
 * partPricing.js's intentionally-naive `line.split(",")` parser cannot
 * handle correctly once columns after price stop being simple values — so a
 * proper quote-aware parser is needed for this half of the row.
 *
 * Row matching reuses partPricing.js's own `deriveAllCsvRowKeys()` (same
 * alias table, same trailing-"(...)" stripping, same extra-key coverage for
 * parts whose catalog name changed over time) so a given Inventory.partName
 * always resolves to the identical CSV row for both price and metadata —
 * they can never disagree about which row a part matches.
 */
const fs = require("fs");
const path = require("path");
const { deriveAllCsvRowKeys } = require("./partPricing");

const CSV_PATH = path.join(__dirname, "..", "assets", "German_Cars_Price_List_20pct.csv");

/**
 * Minimal RFC-4180-style CSV line splitter: handles double-quoted fields,
 * embedded commas inside quotes, and escaped `""` for a literal quote.
 * Deliberately not a full CSV library (per partPricing.js's own precedent)
 * since this is one fixed, small, known file.
 */
function splitCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function parseCsv(raw) {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) return [];

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];

  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    const partName = (cols[headers.indexOf("Part")] || "").trim();
    if (!partName) continue;

    const row = {};
    headers.forEach((header, idx) => {
      row[header] = (cols[idx] || "").trim();
    });
    row.partName = partName;
    rows.push(row);
  }

  return rows;
}

function buildMetadataIndex() {
  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const rows = parseCsv(raw);
  const index = new Map();

  for (const row of rows) {
    for (const key of deriveAllCsvRowKeys(row.partName)) {
      if (index.has(key)) {
        console.warn(
          `[PART_SYNC_METADATA] Duplicate part key "${key}" — CSV rows "${index.get(key).partName}" and "${row.partName}" both resolve to it. Keeping the first.`
        );
        continue;
      }
      index.set(key, row);
    }
  }

  return index;
}

// Loaded and indexed once at module load, mirroring partPricing.js's pattern.
const METADATA_INDEX = buildMetadataIndex();

/**
 * Parse the CSV's "Weight (lbs)" column safely. Never invents a value:
 * blank, non-numeric, zero, or negative all resolve to `undefined` (treated
 * the same as "no CSV row matched" by callers) rather than a guessed number.
 */
function parseWeightLbs(raw, partNameForLog) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;

  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[PART_SYNC_METADATA] Invalid Weight (lbs) value "${raw}" for CSV part "${partNameForLog}" — ignoring.`
    );
    return undefined;
  }
  return n;
}

/**
 * Look up the CSV metadata row for a part.
 *
 * @param {Object} params
 * @param {string} params.partName - Inventory item's partName (same
 *   already-camelCase value passed to resolvePartPrice)
 * @returns {{found: boolean, matchedPartName?: string, productType?: string,
 *   category?: string, productImageUrl?: string, descriptionTemplate?: string,
 *   titleTemplate?: string, handleIdSlug?: string, brandPlaceholder?: string,
 *   weightLbs?: number}}
 */
function resolvePartMetadata({ partName }) {
  if (!partName) return { found: false };

  const partKey = partName.replace(/\s+/g, "").replace(/^./, (c) => c.toLowerCase());
  const row = METADATA_INDEX.get(partKey);

  if (!row) return { found: false };

  return {
    found: true,
    matchedPartName: row.partName,
    productType: row.productType || undefined,
    category: row.category || undefined,
    productImageUrl: row.productImageUrl || undefined,
    descriptionTemplate: row.descriptionTemplate || undefined,
    titleTemplate: row.titleTemplate || undefined,
    handleIdSlug: row.handleIdSlug || undefined,
    brandPlaceholder: row.brand_placeholder || undefined,
    // Authoritative shipping weight source: CSV "Weight (lbs)" column only
    // (never Inventory.weight — no documented fallback to it exists).
    weightLbs: parseWeightLbs(row["Weight (lbs)"], row.partName),
  };
}

/**
 * Replace {YEAR}/{MAKE}/{MODEL} placeholders with real vehicle values.
 * Never leaves a placeholder token in the result — a missing value becomes
 * an empty string rather than an invented one (matches the existing "N/A"
 * data-quality convention used elsewhere in controllers/wix.controller.js would be
 * misleading inside a prose sentence, so this omits the value cleanly
 * instead, e.g. "from a  Hyundai Accent" -> collapsed whitespace below).
 */
function resolveTemplate(template, { year, make, model } = {}) {
  if (!template) return undefined;

  return template
    .replace(/\{YEAR\}/g, year || "")
    .replace(/\{MAKE\}/g, make || "")
    .replace(/\{MODEL\}/g, model || "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Split a possibly-multi-URL productImageUrl (";"-delimited) into an array. */
function splitImageUrls(productImageUrl) {
  if (!productImageUrl) return [];
  return productImageUrl
    .split(";")
    .map((url) => url.trim())
    .filter(Boolean);
}

module.exports = {
  resolvePartMetadata,
  resolveTemplate,
  splitImageUrls,
};
