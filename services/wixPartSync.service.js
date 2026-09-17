/**
 * Canonical Wix Part Sync Service
 *
 * Single source of truth for turning eligible Inventory records into Wix
 * products (create/update) and marking them synced. Extracted from
 * controllers/wix.js's exportAndSyncDeduplicated (the current production
 * deduplicated sync flow — verified against CLOVER_PART_SYNC_DOC..md and
 * the CSV-driven pricing/metadata additions as the only endpoint that both
 * pushes to Wix's Velo `_functions/partSync` AND marks wixSynced/
 * wixProductId only after that push succeeds).
 *
 * This is a REFACTOR, not a rewrite: every field, template string, and
 * fallback for a Wix payload is carried over from the original
 * implementation unchanged. Behavioral corrections applied across three
 * audit passes (all required to close proven or theoretical duplication/
 * data-loss problems — none of them change pricing, metadata, exclusions,
 * or the external HTTP contract):
 *
 *   1. Product identity now includes Trim (see utils/productIdentity.js).
 *      Previously (controllers/wix.js's removed getGroupKey()) two
 *      different trims of the same Year+Make+Model+Part collapsed into ONE
 *      Wix product group, silently merging/losing one trim's identity.
 *
 *   2. The "does a Wix product already exist for this identity" check
 *      (resolveCurrentWixProductId) is a fresh DB read taken at the moment
 *      each group is actually processed, matched by the group's IDENTITY
 *      FIELDS (make+model+trim+year+partName+sku+vin) rather than by this group's
 *      own Inventory _ids. This closes two distinct gaps — see that
 *      function's own doc comment for the full detail:
 *        a) same-process race: two overlapping sync runs pick up the same
 *           not-yet-synced records; the second sees the first's
 *           just-persisted id (this is what makes withIdentityLock()
 *           effective) and updates instead of duplicating.
 *        b) cross-run "restock" gap: a Wix product already exists for this
 *           identity because an earlier, completed run created it off a
 *           DIFFERENT, already-synced Inventory record — invisible to an
 *           id-based check, since an already-synced record is excluded
 *           from selection entirely and never enters any group.
 *
 *      Residual risk (documented, not silently fixed): this is an
 *      in-process guard only. It does not protect against two SEPARATE
 *      Node processes/instances processing the same identity at the same
 *      instant. Closing that would need a DB-level atomic claim (e.g. a
 *      compare-and-swap findOneAndUpdate against a small dedicated
 *      identity-claim collection), which was deliberately not introduced
 *      here per "do not add distributed locking unless actually
 *      necessary" — this codebase currently runs as a single server
 *      process (plain `node server.js`, no PM2/cluster config found
 *      anywhere in this repo), so the in-process guard covers the
 *      realistic race (overlapping/retried requests hitting the same
 *      process).
 *
 *   3. A Wix create/update that succeeds but whose MongoDB persistence
 *      then fails is no longer reported as an indistinguishable generic
 *      failure with the resulting wixProductId discarded. It's now a
 *      distinct status (`failed_after_wix_success`) carrying the real,
 *      live wixProductId, logged loudly — see syncGroupWithWix — so that
 *      state is discoverable for manual reconciliation instead of lost.
 *
 * Everything else — exclusion rules, price resolution, German/Standard
 * classification, CSV metadata resolution, description/title/sku/slug
 * construction, the create-vs-update-vs-recreate-on-stale-id Velo call
 * sequence, and the "mark synced only after Wix succeeds" persistence
 * order — is carried over as-is.
 */
const axios = require("axios");
const crypto = require("crypto");

const WIX_VELO_TIMEOUT_MS = 120000;
const WIX_VELO_MAX_RETRIES = 2;
const WIX_VELO_RETRY_DELAY_MS = 2000;

function isTransientWixError(error) {
  const status = error?.response?.status;

  return (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    error?.code === "ECONNABORTED" ||
    error?.code === "ETIMEDOUT" ||
    error?.code === "ECONNRESET"
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postToWixVelo(url, payload) {
  let lastError;

  for (let attempt = 0; attempt <= WIX_VELO_MAX_RETRIES; attempt++) {
    try {
      return await axios.post(url, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: WIX_VELO_TIMEOUT_MS,
      });
    } catch (error) {
      lastError = error;

      if (!isTransientWixError(error) || attempt === WIX_VELO_MAX_RETRIES) {
        throw error;
      }

      console.warn(
        `[WIX SYNC] Transient Wix request failure. ` +
        `Retrying attempt ${attempt + 2}/${WIX_VELO_MAX_RETRIES + 1} ` +
        `after ${WIX_VELO_RETRY_DELAY_MS}ms.`,
        {
          status: error?.response?.status,
          code: error?.code,
          message: error?.message,
        }
      );

      await sleep(WIX_VELO_RETRY_DELAY_MS);
    }
  }

  throw lastError;
}


const Inventory = require("../models/inventory.model");
const carInTake = require("../models/carIntake.model");

const { resolvePartPrice } = require("../utils/partPricing");
const { isGermanVehicle } = require("../utils/vehicleClassification");
const {
  resolvePartMetadata,
  resolveTemplate,
  splitImageUrls,
} = require("../utils/partSyncMetadata");
const { isWixExcludedPart } = require("../utils/wixExportExclusions");
const { buildProductIdentity } = require("../utils/productIdentity");
const { resolveWixPartCategory } = require("../utils/wixPartCategories");

// ── In-process per-identity queue ───────────────────────────────────────
// See module doc comment above for what this does and does not protect
// against.
const identityQueues = new Map();

function withIdentityLock(identityKey, task) {
  const previousTail = identityQueues.get(identityKey) || Promise.resolve();

  // .catch(() => {}) so one identity's failure never blocks the next
  // caller queued behind it for the SAME identity.
  const runAfterPrevious = previousTail.catch(() => {}).then(() => task());

  identityQueues.set(identityKey, runAfterPrevious);
  runAfterPrevious.finally(() => {
    if (identityQueues.get(identityKey) === runAfterPrevious) {
      identityQueues.delete(identityKey);
    }
  });

  return runAfterPrevious;
}

// ── Small pure helpers (carried over from controllers/wix.js as-is) ────

/**
 * Mirrors controllers/wix.js's own extractBrandName() exactly. Duplicated
 * (not imported) deliberately: controllers/wix.js's copy is still used by
 * its own untouched, currently-unused buildWixProductPayload() helper, and
 * a service should not depend on a controller module.
 */
const extractBrandName = (item) => {
  return (item.make?.name || "Unknown").toUpperCase();
};

/**
 * Generates a deterministic Wix SKU from the canonical product identity.
 * 
 * Important:
 * - Maximum 40 characters.
 * - Same identity always produces the same SKU.
 * - Different identities receive different deterministic suffixes.
 * - Does not use Inventory _id or randomness.
 * - Existing-product update flow does not overwrite SKU.
 */

const generateSku = (identityKey) => {
  const identity = String(identityKey || "").trim();

  if (!identity) {
    throw new Error("Cannot generate SKU without a canonical identity key");
  }

  const normalized = identity
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  // Deterministic SHA-256 hash of the FULL canonical identity.
  const hashSuffix = crypto
    .createHash("sha256")
    .update(identity, "utf8")
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
  

  // Wix SKU maximum: 40 characters.
  const maxPrefixLength = 40 - hashSuffix.length - 1;
  const prefix = normalized.slice(0, Math.max(0, maxPrefixLength));

  return `${prefix}-${hashSuffix}`;
};

/** Carried over verbatim from controllers/wix.js's syncProductFieldsThroughVelo(). */
const syncProductFieldsThroughVelo = async ({
  productId,
  productName,
  partName,
  sku,
  price,
  brand,
  category,
  quantity,
  title,
  merchantCategory,
  merchantProductType,
  fieldtype,
  handledSlug,
  productImage,
  productImages,
  description,
  shippingWeight,
}) => {
  const veloUrl = `${String(process.env.WIX_VELO_BASE_URL || "").replace(
    /\/$/,
    ""
  )}/_functions/partSync`;

  // const response = await axios.post(
  const response = await postToWixVelo(
    veloUrl,
    {
      secret: process.env.PART_SYNC_SECRET,
      productId,
      productName,
      partName,
      sku,
      price,
      brand,
      category,
      quantity,
      title,
      merchantCategory,
      merchantProductType,
      fieldtype,
      handledSlug,
      productImage,
      productImages,
      description,
      shippingWeight,
    },
    // {
    //   headers: { "Content-Type": "application/json" },
    //   timeout: 30000,
    // }
  );

  if (!response.data?.success) {
    throw new Error(response.data?.error || "Wix Velo part-sync returned an error");
  }

  return response.data;
};

// ── Stage 1: eligible-inventory selection (unchanged query shape) ──────

/**
 * Selects Inventory records eligible for Wix sync. Preserves the existing
 * rule exactly: active (not soft-deleted) AND (not marked synced, OR
 * marked synced but missing/invalid wixProductId) — i.e. wixSynced=true is
 * never trusted on its own; a valid wixProductId is also required.
 *
 * This is the ONE selection query used by every canonical sync call — see
 * prepareWixSyncGroups() below, which calls this rather than re-querying,
 * so there is exactly one place this eligibility rule is expressed.
 *
 * @param {Object} [filters] - optional ObjectId filters for a future
 *   filtered canonical call (e.g. { make, model, year }). Unused by the
 *   current deduplicated endpoint (which passes none), kept additive so
 *   legacy filtered endpoints can adopt this function later without a
 *   second selection query being written.
 * @param {number} [limit] - optional cap on how many eligible records to fetch (0 = no cap)
 */
async function fetchEligibleInventory(filters = {}, limit = 0) {
  const query = {
    isDeleted: { $ne: true },
    $or: [
      { wixSynced: { $ne: true } },
      {
        $or: [
          { wixProductId: { $exists: false } },
          { wixProductId: null },
          { wixProductId: "" },
          { wixProductId: "null" },
          { wixProductId: "undefined" },
        ],
      },
    ],
  };

  if (filters.make) query.make = filters.make;
  if (filters.model) query.model = filters.model;
  if (filters.year) query.year = filters.year;
  if (filters.trim) query.trim = filters.trim;
  if (filters.partName) query.partName = filters.partName;

  let cursor = Inventory.find(query)
    // Projection: the canonical sync pipeline (this file) only ever reads
    // _id/partName/make/model/trim/year/vin/category off an Inventory doc —
    // verified against every `item.<field>`/`p.item.<field>` reference in
    // this file and in controllers/wix.js's exportAndSyncDeduplicated
    // response mapping. sku/weight/image/price/etc. are NOT read here (sku
    // is regenerated from the product name via generateSku(), shippingWeight
    // comes from the CSV via partSyncMetadata, not Inventory.weight).
    // wixSynced/wixProductId/isDeleted stay out of the projection too —
    // they're only used above in the query filter, never read back off the
    // fetched docs — filtering on a field doesn't require projecting it.
    // If a future change needs another Inventory field here, add it to this
    // .select() too, or symptoms will show up as `undefined` deep in a Wix
    // payload rather than a clear error.
    .select("_id partName make model trim year vin sku category")
    .populate("make", "name")
    .populate("model", "name")
    .populate("trim", "name");

  if (limit > 0) {
    cursor = cursor.limit(limit);
  }

  return cursor;
}

/** Carried over verbatim from exportAndSyncDeduplicated's inline validity check. */
function filterValidItems(items) {
  return items.filter((item) => {
    const isValid =
      item &&
      item._id &&
      item.partName &&
      item.make?._id &&
      item.model?._id &&
      item.trim?._id;

    if (!isValid) {
      console.warn("[WIX SYNC] Skipping invalid inventory record:", {
        inventoryId: item?._id?.toString() || null,
        partName: item?.partName || null,
        make: item?.make || null,
        model: item?.model || null,
        trim: item?.trim || null,
      });
    }

    return isValid;
  });
}

/** Carried over verbatim: Wix export boundary only (windshield/a1/a2). */
function filterSyncableItems(items) {
  return items.filter((item) => !isWixExcludedPart(item.partName));
}

// ── Stage 2: grouping by canonical product identity ─────────────────────

/**
 * Groups syncable Inventory items by their canonical product identity
 * (Year+Make+Model+Trim+Part — see utils/productIdentity.js). This is the
 * corrected replacement for controllers/wix.js's removed getGroupKey(),
 * which omitted Trim and could merge two different trims' inventory into
 * one Wix product.
 */
function groupInventoryItemsByIdentity(items) {
  const groupMap = new Map();

  for (const item of items) {
    const { key } = buildProductIdentity({
      year: item.year,
      make: item.make?.name,
      model: item.model?.name,
      trim: item.trim?.name,
      partName: item.partName,
      sku: item.sku,
      vin: item.vin,
    });

    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(item);
  }

  return groupMap;
}

// ── Stage 3: build the Wix-bound payload for one group ──────────────────

/**
 * Composite key matching the exact (make,model,trim,year,partName) tuple
 * the original per-group Inventory.countDocuments() call matched on (see
 * buildSyncPayloadForGroup's git history / the comment it used to carry:
 * "Trim-aware quantity: counts only Inventory records that share this
 * group's full identity"). Used to look a group's precomputed quantity up
 * from fetchGroupLevelLookups()'s batched aggregation result instead of
 * issuing one countDocuments() call per group.
 */
function buildQuantityCountKey({ make, model, trim, year, partName, sku, vin }) {
  return [String(make), String(model), String(trim), year, partName, String(sku || ""), String(vin || "")].join("::");
}

/**
 * Batches the two per-group DB lookups buildSyncPayloadForGroup used to
 * issue one at a time, once per group, sequentially (an N-round-trips
 * pattern once there are many product groups): the group's carIntake (by
 * representative VIN) and its total on-hand quantity (countDocuments by
 * exact make+model+trim+year+partName). Same data, same match semantics —
 * just fetched in (up to) 2 round-trips total instead of 2 per group.
 *
 * carIntake lookup: items with a truthy vin are resolved via one batched
 * `find({vin: {$in: [...]}})`, first-doc-per-vin (mirroring findOne()'s
 * "one match" semantics). Items with a falsy vin are NOT included in that
 * batch — they fall back to the exact original `findOne({vin: item.vin})`
 * call in prepareWixSyncGroups below, so a group with no VIN gets byte-for-
 * byte the same lookup behavior it always did, whatever that resolves to.
 *
 * Quantity: one aggregation, $match'd down to only the (make,model,trim,
 * year,partName) tuples actually needed (one per group — a group's own
 * representative item is itself always a match, so every group is
 * guaranteed a result row), instead of one countDocuments() per group.
 */
async function fetchGroupLevelLookups(groupMap) {
  const representativeItems = [...groupMap.values()].map((groupItems) => groupItems[0]);

  const vins = [...new Set(representativeItems.map((item) => item.vin).filter(Boolean))];
  const intakeByVin = new Map();
  if (vins.length) {
    const intakes = await carInTake.find({ vin: { $in: vins } }).lean();
    for (const doc of intakes) {
      if (!intakeByVin.has(doc.vin)) intakeByVin.set(doc.vin, doc);
    }
  }

  const quantityByKey = new Map();
  if (representativeItems.length) {
    const orClauses = representativeItems.map((item) => ({
      make: item.make._id,
      model: item.model._id,
      trim: item.trim._id,
      year: item.year,
      partName: item.partName,
      sku: item.sku,
      vin: item.vin,
    }));

    const counts = await Inventory.aggregate([
      { $match: { isDeleted: { $ne: true }, $or: orClauses } },
      {
        $group: {
          _id: { make: "$make", model: "$model", trim: "$trim", year: "$year", partName: "$partName", sku: "$sku", vin: "$vin", },
          count: { $sum: 1 },
        },
      },
    ]);

    for (const row of counts) {
      quantityByKey.set(buildQuantityCountKey(row._id), row.count);
    }
  }

  return { intakeByVin, quantityByKey };
}

/**
 * Builds the sync payload for one product-identity group. Field-for-field
 * identical to exportAndSyncDeduplicated's original inline logic, with one
 * correction (carried over from before this file was batching-optimized):
 * the group quantity count also filters by trim (required once Trim became
 * part of the identity — otherwise a product identified as, say,
 * "...-xdrive35i-front-bumper" would report a quantity that still included
 * a different trim's units, which the old code never separated).
 *
 * `intake` and `quantity` are now precomputed by fetchGroupLevelLookups()
 * (or its per-item fallback in prepareWixSyncGroups) and passed in — this
 * function itself no longer performs any DB I/O, so it's safe/cheap to call
 * once per group with no `await`.
 */
function buildSyncPayloadForGroup(identityKey, groupItems, { intake, quantity }) {
  const item = groupItems[0];

  const formattedPartName = item.partName
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase())
    .trim();

  const vehicleName = [
    item.year,
    item.make?.name?.toUpperCase(),
    item.model?.name,
    item.trim?.name,
  ]
    .filter(Boolean)
    .join(" ");

  // Wix limits product names to 80 characters.
  // Preserve the existing full name whenever possible. If the full
  // vehicle name is too long, progressively remove the trim first,
  // then shorten the vehicle portion only as a final fallback.
  const MAX_WIX_PRODUCT_NAME_LENGTH = 80;
  const productNameSuffix = ` - ${formattedPartName}`;

  const vehicleNameWithoutTrim = [
    item.year,
    item.make?.name?.toUpperCase(),
    item.model?.name,
  ]
    .filter(Boolean)
    .join(" ");

  const productNameCandidates = [
    vehicleName,
    vehicleNameWithoutTrim,
    [item.year, item.make?.name?.toUpperCase()].filter(Boolean).join(" "),
    String(item.year || "").trim(),
  ];

  let productName = "";

  for (const candidateVehicleName of productNameCandidates) {
    const candidate = `${candidateVehicleName}${productNameSuffix}`;

    if (candidate.length <= MAX_WIX_PRODUCT_NAME_LENGTH) {
      productName = candidate;
      break;
    }
  }

  // Final safety net: never allow a Wix-invalid name, and never cut
  // the part name itself.
  if (!productName) {
    const maxVehicleLength =
      MAX_WIX_PRODUCT_NAME_LENGTH - productNameSuffix.length;

    const safeVehicleName = vehicleName
      .slice(0, Math.max(0, maxVehicleLength))
      .trim();

    productName = `${safeVehicleName}${productNameSuffix}`;
  }

  const sku = generateSku(identityKey);

  const { price } = resolvePartPrice({
    partName: item.partName,
    isGerman: isGermanVehicle(item.make?.name),
  });

  const val = (...args) => {
    for (const arg of args) {
      if (arg && arg !== "N/A" && arg !== "") return arg;
    }
    return "N/A";
  };

  const cd = intake?.carDetails || {};
  const vd = intake?.vinDetails || {};

  const sourceVehicleHtml = `<ul>
      <li><p>Year:${val(item.year, vd.ModelYear)}</p></li>
      <li><p>Make:${val(item.make?.name, vd.Make)}</p></li>
      <li><p>Model:${val(item.model?.name, vd.Model)}</p></li>
      <li><p>Model Type:${val(item.trim?.name, vd.Trim)}</p></li>
      <li><p>Body:${val(cd.bodyClass, vd.BodyClass)}</p></li>
      <li><p>Door Structure:${val(cd.doorCount, vd.Doors)}</p></li>
      <li><p>Cylinders:${val(cd.cylinders, vd.EngineCylinders)}</p></li>
      <li><p>Engine Size:${val(cd.engine, vd.DisplacementL)}</p></li>
      <li><p>Transmission:${val(cd.transmission, vd.TransmissionStyle)}</p></li>
      <li><p>Drive Train:${val(cd.drive, vd.DriveType)}</p></li>
      </ul>`;

  const fallbackDescription = `${formattedPartName}, Condition: Used, ` +
    `Year: ${item.year}, Make: ${item.make?.name}, ` +
    `Model: ${item.model?.name}, Trim: ${item.trim?.name}`;

  const csvMeta = resolvePartMetadata({ partName: item.partName });

  const description = csvMeta.found
    ? resolveTemplate(csvMeta.descriptionTemplate, {
        year: item.year,
        make: item.make?.name,
        model: item.model?.name,
      })
    : fallbackDescription;

  const productImages = csvMeta.found ? splitImageUrls(csvMeta.productImageUrl) : [];
  const primaryImage = productImages[0] || undefined;

  const merchantProductType = csvMeta.productType || "Auto Part";
  const merchantCategory = csvMeta.category || "Used Auto Parts";
  const fieldtype = "Product";

  // Wix category is determined by the canonical partName mapping.
  // Do not rely on Mongo Inventory.category, which may be "Uncategorized".
  const wixCategory = resolveWixPartCategory(item.partName);

  const handledSlug = csvMeta.found
    ? [csvMeta.handleIdSlug, item.year, item.make?.name, item.model?.name]
        .filter(Boolean)
        .join("-")
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
    : undefined;

  const title = `${val(item.year, vd.ModelYear)} ${val(item.make?.name, vd.Make)} ${val(item.model?.name, vd.Model)}(Used, Good Condition)`;

  const shippingWeight = csvMeta.weightLbs;

  return {
    identityKey,
    productName,
    partName: item.partName,
    title,
    sku,
    price,
    quantity,
    item,
    intake,
    sourceVehicleHtml,
    description,
    productImages,
    primaryImage,
    merchantProductType,
    merchantCategory,
    fieldtype,
    wixCategory,
    handledSlug,
    shippingWeight,
    formattedPartName,
    groupItems,
  };
}

/**
 * Full "prepare" phase: selects eligible inventory, validates it, applies
 * exclusion rules, groups by canonical identity, and builds a sync payload
 * per group. Performs no Wix API calls and no DB writes — safe to call
 * multiple times / speculatively, and safe to run before sending an HTTP
 * response (mirrors the current deduplicated endpoint's "respond first,
 * sync in background" shape).
 *
 * @param {Object} [options]
 * @param {Object} [options.filters] - optional selection filters, see fetchEligibleInventory
 * @param {number} [options.limit] - optional cap on how many eligible Inventory records to fetch
 * @returns {Promise<{ payloads: Array, totalItems: number }>}
 */
async function prepareWixSyncGroups({ filters = {}, limit = 0 } = {}) {
  const items = await fetchEligibleInventory(filters, limit);

  const validItems = filterValidItems(items);
  const syncableItems = filterSyncableItems(validItems);

  const excludedCount = validItems.length - syncableItems.length;
  if (excludedCount > 0) {
    console.log(`[WIX SYNC] Excluded ${excludedCount} Wix-excluded item(s) from this sync (see utils/wixExportExclusions.js).`);
  }

  const groupMap = groupInventoryItemsByIdentity(syncableItems);

  const { intakeByVin, quantityByKey } = await fetchGroupLevelLookups(groupMap);

  const payloads = [];
  for (const [identityKey, groupItems] of groupMap.entries()) {
    const item = groupItems[0];

    let intake;
    if (item.vin) {
      intake = intakeByVin.get(item.vin) || null;
    } else {
      // Not covered by the batched $in lookup above (which only queries
      // truthy vins) — fall back to the exact original per-item query so a
      // group with no VIN keeps byte-for-byte the same behavior it always had.
      intake = await carInTake.findOne({ vin: item.vin }).lean();
    }

    const quantityKey = buildQuantityCountKey({
      make: item.make._id,
      model: item.model._id,
      trim: item.trim._id,
      year: item.year,
      partName: item.partName,
      sku: item.sku,
      vin: item.vin,
    });

    let quantity = quantityByKey.get(quantityKey);
    if (quantity === undefined) {
      // Defensive fallback only — should be unreachable, since the batched
      // aggregation's $or always includes this exact tuple (the group's own
      // representative item matches it). Kept so a batching edge case can
      // never silently produce a wrong stock quantity.
      quantity = await Inventory.countDocuments({
        make: item.make._id,
        model: item.model._id,
        trim: item.trim._id,
        year: item.year,
        partName: item.partName,
        sku: item.sku,
        vin: item.vin,
        isDeleted: { $ne: true },
      });
    }

    payloads.push(buildSyncPayloadForGroup(identityKey, groupItems, { intake, quantity }));
  }

  return { payloads, totalItems: validItems.length };
}

// ── Stage 4: existence check + create/update + persistence ─────────────

/**
 * Resolves the current, authoritative wixProductId for a product identity —
 * a fresh DB read taken at the moment the group is actually processed (not
 * the in-memory snapshot from prepareWixSyncGroups).
 *
 * Matches by the group's identity fields (make+model+trim+year+partName),
 * NOT by this group's own Inventory _ids. This is a deliberate widening
 * from an earlier version of this function (which only re-read the ids of
 * THIS group's own, currently-not-yet-synced items) that closed two
 * distinct duplicate-creation gaps:
 *
 *   1. Same-process race (already covered by the narrower, id-based
 *      version): two overlapping sync runs pick up the same not-yet-synced
 *      records; whichever finishes second sees the first run's
 *      just-persisted wixProductId here — this is what makes
 *      withIdentityLock() effective — and updates instead of duplicating.
 *
 *   2. Cross-run "restock" gap (the id-based version MISSED this — found
 *      during the production-hardening audit): a Wix product can already
 *      exist for this identity because an earlier, completed sync run
 *      already created it off a DIFFERENT, already-synced Inventory
 *      record. That record is excluded from fetchEligibleInventory's
 *      selection entirely (it's already synced) and so never appears in
 *      ANY group's groupItems — an id-based lookup could never find it.
 *      Concretely: a 2012 BMW X5 xDrive35i Front Bumper is synced and gets
 *      a wixProductId. Weeks later a second 2012 BMW X5 xDrive35i is
 *      scrapped and its Front Bumper added to Inventory. That new record
 *      has no wixProductId. The id-based check saw no wixProductId among
 *      ITS OWN group's ids (the new record is the only member) and would
 *      create a SECOND Wix product for an identity that already has one.
 *      Matching by identity fields instead finds the already-synced
 *      sibling directly, and the new record gets linked to the SAME
 *      existing Wix product via the normal update-existing-product path.
 *
 * isDeleted is excluded, mirroring every other identity-scoped query in
 * this file (a soft-deleted record's Wix linkage is not treated as
 * authoritative). `.sort({ _id: 1 })` makes the result deterministic
 * (oldest matching record wins) in the data-quality edge case where more
 * than one wixProductId already exists for this identity — only possible
 * if this exact bug already produced a duplicate before this fix; sorting
 * doesn't repair that, it just avoids adding a second source of
 * nondeterminism on top of an already-bad state (see the Reconciliation
 * Design in the hardening-pass report for how to detect/repair it).
 *
 * @returns {Promise<{ wixProductId: string, sourceInventoryId: string } | null>}
 */
async function resolveCurrentWixProductId(groupItems) {
  const item = groupItems[0];

  const existing = await Inventory.findOne(
    {
      make: item.make._id,
      model: item.model._id,
      trim: item.trim._id,
      year: item.year,
      partName: item.partName,
      sku: item.sku,
      vin: item.vin,
      isDeleted: { $ne: true },
      wixProductId: { $nin: [null, "", "null", "undefined"] },
    },
    { wixProductId: 1 }
  )
    .sort({ _id: 1 })
    .lean();

  if (!existing) return null;

  return { wixProductId: existing.wixProductId, sourceInventoryId: existing._id.toString() };
}

/**
 * Marks every grouped Inventory record synced, only called after a
 * successful Wix create/update. Every record in a group gets the identical
 * { wixSynced: true, wixSyncedAt, wixProductId } — previously written via
 * one findByIdAndUpdate() per record (N writes per group); now one
 * updateMany() across the group's ids (1 write per group). Same field
 * values land on every document either way; the only observable difference
 * is that all records in a group now share the exact same wixSyncedAt
 * timestamp instead of each getting its own `new Date()` a few ms apart,
 * which was never a meaningful distinction downstream.
 */
async function persistGroupSyncState(groupItems, wixProductId) {
  const ids = groupItems.map((gItem) => gItem._id);

  if (!ids.length) {
    throw new Error("Cannot persist Wix sync state: no inventory IDs supplied");
  }

  if (!wixProductId) {
    throw new Error("Cannot persist Wix sync state: wixProductId is missing");
  }

  const result = await Inventory.updateMany(
    { _id: { $in: ids } },
    {
      $set: {
        wixSynced: true,
        wixSyncedAt: new Date(),
        wixProductId,
      },
    }
  );

  const matchedCount =
    typeof result.matchedCount === "number"
      ? result.matchedCount
      : result.n;

  const modifiedCount =
    typeof result.modifiedCount === "number"
      ? result.modifiedCount
      : result.nModified;

  console.log("[WIX SYNC] Mongo persistence result:", {
    inventoryIds: ids.map((id) => String(id)),
    wixProductId,
    matchedCount,
    modifiedCount,
  });

  if (matchedCount !== ids.length) {
    throw new Error(
      `Mongo persistence mismatch: expected ${ids.length} inventory record(s), matched ${matchedCount}. ` +
      `inventoryIds=${ids.map((id) => String(id)).join(",")}`
    );
  }

  return {
    matchedCount,
    modifiedCount,
  };
}

/**
 * Processes one prepared group: existence check -> update existing Wix
 * product (recreating if the stored ID turns out stale) or create a new
 * one -> persist wixSynced/wixProductId only on success. Serialized per
 * identity via withIdentityLock so two overlapping sync runs can never
 * both create a product for the same identity within this process.
 *
 * `reason` is an internal-only observability field (see the hardening-pass
 * report's "Sync Observability" section) — it distinguishes *why* a status
 * was reached without changing the small `status` enum any other code
 * might branch on:
 *   CREATED_NEW_PRODUCT              - no existing product found anywhere
 *   REUSED_EXISTING_PRODUCT_SAME_BATCH
 *                                     - existing id found among THIS
 *                                       group's own Inventory records (the
 *                                       same-process race-close case)
 *   REUSED_EXISTING_PRODUCT_SIBLING  - existing id found on a DIFFERENT,
 *                                       previously-synced Inventory record
 *                                       sharing this identity — i.e. a
 *                                       duplicate Wix product creation was
 *                                       just prevented (the "restock" gap
 *                                       fixed in resolveCurrentWixProductId)
 *   RECREATED_STALE_PRODUCT          - a stored id was found but Wix no
 *                                       longer has it; created a replacement
 *   SYNC_STATE_PERSIST_FAILED        - Wix succeeded but writing wixSynced/
 *                                       wixProductId back to Mongo failed
 *   WIX_API_ERROR                    - the Wix/Velo call itself failed;
 *                                       nothing was created or updated
 *
 * @returns {Promise<{ identityKey: string, status: "created"|"updated"|"failed"|"failed_after_wix_success", reason: string, wixProductId: string|null, error?: string }>}
 */
async function syncGroupWithWix(p) {
  return withIdentityLock(p.identityKey, async () => {
    const inventoryIds = p.groupItems.map((i) => i._id.toString());
    const context = {
      identityKey: p.identityKey,
      inventoryIds,
      make: p.item.make?.name,
      model: p.item.model?.name,
      year: p.item.year,
      trim: p.item.trim?.name,
      partName: p.item.partName,
    };

    let pid = null;
    let status = null;
    let reason = null;

    try {
      const existingProduct = await resolveCurrentWixProductId(p.groupItems);
      pid = existingProduct?.wixProductId || null;
      // No extra query — sourceInventoryId already came back with the
      // lookup above. Purely a label for observability (see doc comment):
      // does NOT affect which Wix call is made, only what gets logged/
      // returned, so it can never change sync behavior.
      const foundViaSibling =
        Boolean(existingProduct) && !inventoryIds.includes(existingProduct.sourceInventoryId);

      if (pid) {
        try {
          console.log(`[WIX SYNC] Syncing existing Wix product ${pid} through Velo`, context);

          await syncProductFieldsThroughVelo({
            productId: pid,
            productName: p.productName,
            partName: p.partName,
            sku: p.sku,
            price: Number(p.price || 0),
            brand: extractBrandName(p.item),
            category: p.wixCategory,
            quantity: p.quantity,
            title: p.title,
            merchantCategory: p.merchantCategory,
            merchantProductType: p.merchantProductType,
            fieldtype: p.fieldtype,
            handledSlug: p.handledSlug,
            productImage: p.primaryImage,
            productImages: p.productImages,
            description: p.description,
            shippingWeight: p.shippingWeight,
          });

          status = "updated";
          reason = foundViaSibling ? "REUSED_EXISTING_PRODUCT_SIBLING" : "REUSED_EXISTING_PRODUCT_SAME_BATCH";
          console.log(`[WIX SYNC] Existing Wix product synced: ${pid}`);
        } catch (existingProductError) {
          const wixErrorMessage =
            existingProductError.response?.data?.error || existingProductError.message || "";

          const productNotFound =
            existingProductError.response?.status === 500 &&
            wixErrorMessage.includes("was not found");

          if (!productNotFound) {
            throw existingProductError;
          }

          console.warn(
            `[WIX SYNC] Stored Wix ID ${pid} no longer exists in Wix. Creating a new product instead.`,
            context
          );
          pid = null;
        }
      }

      if (!pid) {
        const veloBaseUrl = String(process.env.WIX_VELO_BASE_URL || "").replace(/\/$/, "");

        if (!veloBaseUrl) throw new Error("WIX_VELO_BASE_URL is missing in .env");
        if (!process.env.PART_SYNC_SECRET) throw new Error("PART_SYNC_SECRET is missing in .env");

        console.log(`[WIX SYNC] Sending "${p.productName}" to Wix Velo for creation`, context);

        // const veloResponse = await axios.post(
        const veloResponse = await postToWixVelo(
          `${veloBaseUrl}/_functions/partSync`,
          {
            secret: process.env.PART_SYNC_SECRET,
            productName: p.productName,
            title: p.title,
            sku: p.sku,
            price: Number(p.price || 0),
            brand: extractBrandName(p.item),
            category: p.wixCategory,
            merchantCategory: p.merchantCategory,
            merchantProductType: p.merchantProductType,
            fieldtype: p.fieldtype,
            handledSlug: p.handledSlug,
            productImage: p.primaryImage,
            productImages: p.productImages,
            quantity: Number(p.quantity || 0),
            description: p.description || "",
            shippingWeight: p.shippingWeight,
          },
          // {
          //   headers: { "Content-Type": "application/json" },
          //   timeout: 30000,
          // }
        );

        const veloData = veloResponse.data;

        if (!veloData?.success || !veloData?.productId) {
          throw new Error(`Wix Velo create failed: ${veloData?.error || "No productId returned"}`);
        }

        pid = veloData.productId;
        status = "created";
        reason = reason === null ? "CREATED_NEW_PRODUCT" : "RECREATED_STALE_PRODUCT";
        console.log(`[WIX SYNC] Velo created Wix product ${pid}`);
      }

      try {
        await persistGroupSyncState(p.groupItems, pid);
      } catch (persistErr) {
        // Wix succeeded (status/pid above are real and live) but writing
        // that back to MongoDB failed. This is the one crash window this
        // system cannot fully self-heal without a DB-level atomic claim
        // (see "Concurrency" / "Failure Recovery" in the hardening-pass
        // report) — these inventory records stay wixSynced=false and will
        // be retried by the next sync run, which (thanks to
        // resolveCurrentWixProductId's identity-based lookup) will find
        // and reuse THIS SAME wixProductId rather than creating a second
        // one, *as long as some other record in this identity group
        // successfully persists it first*. If every record in the group
        // hits this same failure, no DB record anywhere reflects this
        // wixProductId, and a future run cannot discover it — surfacing
        // the real id here, loudly, is what makes that state discoverable
        // for manual reconciliation instead of silently lost.
        console.error(
          `[WIX SYNC] CRITICAL: Wix ${status} succeeded (wixProductId=${pid}) but persisting sync state to MongoDB failed. Manual reconciliation required.`,
          { ...context, wixProductId: pid, persistError: persistErr.message }
        );

        return {
          ...context,
          status: "failed_after_wix_success",
          reason: "SYNC_STATE_PERSIST_FAILED",
          wixProductId: pid,
          error: `Wix ${status} succeeded but DB persistence failed: ${persistErr.message}`,
        };
      }

      console.log(
        `[WIX SYNC ACTION] identity=${p.identityKey} action=${reason} wixProductId=${pid} inventoryIds=${inventoryIds.join(",")}`
      );

      return { ...context, status, reason, wixProductId: pid };
    } catch (wixErr) {
      console.error(`[WIX SYNC] Wix API error for "${p.productName}":`, {
        status: wixErr.response?.status,
        statusText: wixErr.response?.statusText,
        data: wixErr.response?.data,
        message: wixErr.message,
      });

      return { ...context, status: "failed", reason: "WIX_API_ERROR", wixProductId: null, error: wixErr.message };
    }
  });
}

/**
 * Runs `worker` over `items` with at most `concurrency` calls in flight at
 * once, preserving each result at its original index (order-stable output
 * even though completion order isn't). No new dependency — this codebase
 * has no p-limit/bottleneck/etc. installed, and this is ~10 lines.
 */
async function runWithConcurrency(items, worker, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    for (;;) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, runner));

  return results;
}

/**
 * How many product groups executeWixSyncForGroups processes concurrently.
 * Defaults to 1 (fully sequential — the historical, current behavior of
 * this endpoint) because no verified-safe concurrency ceiling for the Wix
 * Velo `_functions/partSync` endpoint exists anywhere in this codebase.
 * The only precedent for concurrent Wix calls found here is
 * Inventory.controller.js's syncInventoriesV3, which hardcodes
 * `CONCURRENCY = 2` against the (different) Wix Stores v3 bulk-products
 * REST API — that is evidence this system's operators consider *some*
 * concurrency safe against *a* Wix endpoint, not proof of a safe number for
 * this one. Rather than guess, this stays an explicit opt-in: set
 * WIX_SYNC_CONCURRENCY once Velo/Wix rate-limit behavior for this specific
 * endpoint has actually been verified.
 */
const WIX_SYNC_CONCURRENCY = (() => {
  const raw = parseInt(process.env.WIX_SYNC_CONCURRENCY, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
})();

/**
 * Executes the Wix create/update/persist phase for every prepared group.
 * Never throws per-group — one group's failure is captured in its own
 * result entry so it can never abort processing of the other groups
 * (preserves the original per-item try/catch-and-continue behavior). Each
 * group is already serialized against same-identity work from an
 * overlapping request via withIdentityLock() inside syncGroupWithWix, and
 * every group in one `payloads` array is a distinct identity by
 * construction (groupInventoryItemsByIdentity's Map has one entry per
 * identity) — so running groups concurrently here never races two syncs
 * for the same identity against each other.
 *
 * @returns {Promise<{ syncedCount: number, errorCount: number, duplicatesPreventedCount: number, results: Array }>}
 */
async function executeWixSyncForGroups(payloads) {
  console.log(
    `[WIX SYNC] Starting sync for ${payloads.length} product groups (concurrency=${WIX_SYNC_CONCURRENCY})...`
  );

  const results = await runWithConcurrency(payloads, (p) => syncGroupWithWix(p), WIX_SYNC_CONCURRENCY);

  const syncedCount = results.filter((r) => r.status === "created" || r.status === "updated").length;
  // Includes "failed_after_wix_success" (see syncGroupWithWix) — Wix itself
  // succeeded there, but the sync as a whole did not (the DB never learned
  // the resulting wixProductId), so it counts as an error for this summary
  // and needs the same operator attention as any other failure.
  const errorCount = results.filter(
    (r) => r.status === "failed" || r.status === "failed_after_wix_success"
  ).length;
  // Every REUSED_EXISTING_PRODUCT_SIBLING is a group whose id would have
  // gone entirely unfound by the old id-only existence check and would
  // have created a second Wix product for an identity that already had
  // one — i.e. a duplicate this run actually prevented, not just a normal
  // update. Internal metric only (see resolveCurrentWixProductId's doc
  // comment for the exact scenario this counts).
  const duplicatesPreventedCount = results.filter(
    (r) => r.reason === "REUSED_EXISTING_PRODUCT_SIBLING"
  ).length;

  console.log(
    `[WIX SYNC] Sync complete: ${syncedCount} success, ${errorCount} errors, ${duplicatesPreventedCount} duplicate(s) prevented.`
  );

  return { syncedCount, errorCount, duplicatesPreventedCount, results };
}

/**
 * Convenience orchestrator combining prepare + execute for callers that
 * don't need the "respond immediately, sync in background" split (e.g. a
 * future filtered legacy endpoint). The current /export/parts/deduplicated
 * endpoint does NOT use this — it calls prepareWixSyncGroups and
 * executeWixSyncForGroups separately so it can preserve its existing
 * respond-before-background-sync timing exactly.
 */
async function canonicalSyncParts({ filters = {}, limit = 0 } = {}) {
  const { payloads, totalItems } = await prepareWixSyncGroups({ filters, limit });
  const execution = await executeWixSyncForGroups(payloads);
  return { totalItems, payloads, ...execution };
}

module.exports = {
  fetchEligibleInventory,
  filterValidItems,
  filterSyncableItems,
  groupInventoryItemsByIdentity,
  buildQuantityCountKey,
  fetchGroupLevelLookups,
  buildSyncPayloadForGroup,
  prepareWixSyncGroups,
  resolveCurrentWixProductId,
  persistGroupSyncState,
  syncGroupWithWix,
  runWithConcurrency,
  executeWixSyncForGroups,
  canonicalSyncParts,
  extractBrandName,
  generateSku,
};
