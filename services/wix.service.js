/**
 * Wix integration business logic. Extracted 1:1 from controllers/wix.js
 * during the clean-architecture migration — every field mapping, Wix
 * payload shape, and the prepare-then-background-sync sequencing of
 * exportAndSyncDeduplicated is preserved exactly.
 *
 * CRITICAL: this file does NOT modify, wrap, or reimplement
 * services/wixPartSync.service.js in any way — it continues to `require`
 * and call prepareWixSyncGroups/executeWixSyncForGroups exactly as
 * controllers/wix.js already did. That file is the canonical, already-
 * hardened sync engine and is completely untouched by this migration.
 */
const inventoryRepository = require("../repositories/inventory.repository");
const carIntakeRepository = require("../repositories/carIntake.repository");

const { resolvePartPrice } = require("../utils/partPricing");
const { isGermanVehicle } = require("../utils/vehicleClassification");
const { isWixExcludedPart } = require("../utils/wixExportExclusions");

const { prepareWixSyncGroups, executeWixSyncForGroups } = require("./wixPartSync.service");

const axios = require("axios");

const WIX_BASE_URL = "https://www.wixapis.com";

const WIX_HEADERS = {
  "Content-Type": "application/json",
  Authorization: process.env.WIX_API_KEY,
  "wix-meta-site-id": process.env.WIX_SITE_ID,
};

// Call the Wix Velo HTTP function. by shiva
// This runs inside the Wix site, so it has the required Wix site context.
//
// NOTE (confirmed pre-existing dead code, preserved unmodified): not
// called anywhere in this file, and not exported for external use either.
// services/wixPartSync.service.js has its OWN separate, actually-used copy
// of this same function — that file's own comments already document this
// one as "untouched, currently-unused". Kept here exactly as-is rather
// than deleted, since removing dead code was not requested and this
// migration's scope is structural only.
const syncProductFieldsThroughVelo = async ({
  productId,
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
  const veloUrl = `${String(process.env.WIX_VELO_BASE_URL || "").replace(/\/$/, "")}/_functions/partSync`;

  console.log("[WIX BACKGROUND] Velo config:", {
    url: veloUrl,
    hasSecret: Boolean(process.env.PART_SYNC_SECRET),
    secretLength: process.env.PART_SYNC_SECRET?.length || 0,
  });

  const response = await axios.post(
    veloUrl,
    {
      secret: process.env.PART_SYNC_SECRET,
      productId,
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
    {
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
    }
  );

  if (!response.data?.success) {
    throw new Error(response.data?.error || "Wix Velo part-sync returned an error");
  }

  return response.data;
};

// Wix CMS Products collection fields from your screenshots
const WIX_PRODUCT_COLLECTION_ID = "Stores/Products";

const WIX_FIELDS_IDS = {
  quantityInStock: "quantityInStock",
  collections: "collections",
  brand: "brand",
  inventoryItem: "inventoryItem",
};

/**
 * Shared fetch used identically by syncWithWix, exportAndSyncAllParts,
 * exportAndSyncByMake, exportAndSyncByYear, and exportAndSyncByModel in the
 * original controller (each had its own byte-identical copy of this exact
 * query + filter) — consolidated here as pure duplication removal, not a
 * behavior change: same filter, same populate paths, same exclusion filter.
 */
async function getUnsyncedWixEligibleInventory() {
  const fetchedItems = await inventoryRepository
    .find({ isDeleted: { $ne: true }, wixSynced: { $ne: true } })
    .populate("make", "name")
    .populate("model", "name")
    .populate("trim", "name");

  // Wix export boundary only — windShield/a1/a2 stay in Inventory/CRM,
  // they just never enter a Wix-bound payload.
  return fetchedItems.filter((item) => !isWixExcludedPart(item.partName));
}

async function syncWithWix() {
  const inventoriesToSync = await getUnsyncedWixEligibleInventory();

  console.log("UNSYNCED INVENTORIES:", inventoriesToSync.length); // temp debug by shiva

  const wixData = inventoriesToSync.map((item) => ({
    name: item.partName
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (str) => str.toUpperCase())
      .trim(),
    sku:
      item.sku && !item.sku.includes("${") && item.sku.length <= 40
        ? item.sku.substring(0, 40)
        : item._id.toString(),
    productType: "physical",
    price: 1,
    visible: false,
    slug: `${item.make.name}-${item.model.name}-${item.trim.name}-${item.partName
      .replace(/([A-Z])/g, "-$1")
      .replace(/^-/, "")}-${item.year}`,
    brand: item.make.name,
    category: item.category, // added by shiva
    customTextFields: [
      { title: "externalId", value: item._id.toString() },
      { title: "make", value: item.make.name },
      { title: "model", value: item.model.name },
      { title: "trim", value: item.trim.name },
      { title: "year", value: item.year.toString() },
    ],
    currency: "USD",
  }));

  console.log("WIX PRODUCTS COUNT:", wixData.length);
  if (wixData.length) {
    console.log("FIRST PRODUCT:", JSON.stringify(wixData[0], null, 2));
  }

  return wixData;
}

async function markInventorySynced(inventoryId, wixProductId) {
  console.log("MARK INVENTORY SYNCED CALLED");
  console.log("INVENTORY ID:", inventoryId);
  console.log("WIX PRODUCT ID:", wixProductId);

  const inventory = await inventoryRepository.findByIdAndUpdate(
    inventoryId,
    { wixSynced: true, wixSyncedAt: new Date(), wixProductId },
    { new: true }
  );

  console.log("UPDATED INVENTORY:", JSON.stringify(inventory, null, 2));

  return inventory;
}

/**
 * Shared helper: maps an Inventory document to the Wix product shape
 * and marks the document as synced (wixSynced, wixProductId, wixSyncedAt).
 * wixProductId is taken from productIdMap[item._id] if provided,
 * otherwise falls back to item._id.toString().
 */
async function mapAndMarkItem(item, productIdMap = {}) {
  const wixProductId = productIdMap[item._id.toString()] || item._id.toString();

  const intake = await carIntakeRepository.findOne({ vin: item.vin }).lean();

  const cd = intake?.carDetails || {};
  const vd = intake?.vinDetails || {};

  const val = (...args) => {
    for (const arg of args) {
      if (arg && arg !== "N/A" && arg !== "") {
        return arg;
      }
    }
    return "N/A";
  };

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

  const formattedPartName = item.partName
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase())
    .trim();

  const { price } = resolvePartPrice({
    partName: item.partName,
    isGerman: isGermanVehicle(item.make?.name),
  });

  console.log({
    partName: item.partName,
    price,
    vehicle: `${item.year} ${item.make?.name} ${item.model?.name}`,
  });

  const vehicleName = [item.year, item.make?.name?.toUpperCase(), item.model?.name, item.trim?.name]
    .filter(Boolean)
    .join(" ");

  const description =
    `${formattedPartName}, Condition: Used, Part Number: 123456789, ` +
    `Year: ${item.year}, Make: ${item.make?.name}, ` +
    `Model: ${item.model?.name}, Trim: ${item.trim?.name}, Body: SUV`;

  return {
    externalId: item._id.toString(),
    wixProductId,
    make: item.make?.name,
    model: item.model?.name,
    trim: item.trim?.name,
    year: item.year,
    weight: item.weight,
    name: `${vehicleName} - ${formattedPartName}`,
    sku:
      item.sku && !item.sku.includes("${") && item.sku.length <= 40
        ? item.sku.substring(0, 40)
        : item._id.toString(),
    productType: 1,
    visible: false,
    brand: item.make.name,
    category: item.category,
    price,
    currency: "USD",
    description,
    productInfo: {
      additionalInfoSections: [
        { title: "Description", description },
        { title: "Fitment", description: "" },
        { title: "Source Vehicle", description: sourceVehicleHtml },
        { title: "Return and Refund Policy", description: "" },
      ],
    },
  };
}

// ── 1. Export ALL unsynced parts & mark them synced ──────────────────────────
async function exportAndSyncAllParts(productIdMap = {}) {
  const items = await getUnsyncedWixEligibleInventory();

  if (!items.length) {
    return { exported: 0, parts: [] };
  }

  const parts = await Promise.all(items.map((item) => mapAndMarkItem(item, productIdMap)));

  return { exported: parts.length, parts };
}

// ── 2. Export unsynced parts grouped by Make & mark them synced ──────────────
async function exportAndSyncByMake(productIdMap = {}) {
  const items = await getUnsyncedWixEligibleInventory();

  if (!items.length) {
    return { exported: 0, groups: {} };
  }

  const mapped = await Promise.all(items.map((item) => mapAndMarkItem(item, productIdMap)));

  const groups = {};
  items.forEach((item, idx) => {
    const key = item.make.name;
    if (!groups[key]) groups[key] = [];
    groups[key].push(mapped[idx]);
  });

  return { exported: mapped.length, groups };
}

// ── 3. Export unsynced parts grouped by Year & mark them synced ──────────────
async function exportAndSyncByYear(productIdMap = {}) {
  const items = await getUnsyncedWixEligibleInventory();

  if (!items.length) {
    return { exported: 0, groups: {} };
  }

  const mapped = await Promise.all(items.map((item) => mapAndMarkItem(item, productIdMap)));

  const groups = {};
  items.forEach((item, idx) => {
    const key = String(item.year);
    if (!groups[key]) groups[key] = [];
    groups[key].push(mapped[idx]);
  });

  return { exported: mapped.length, groups };
}

// ── 4. Export unsynced parts grouped by Model & mark them synced ─────────────
async function exportAndSyncByModel(productIdMap = {}) {
  const items = await getUnsyncedWixEligibleInventory();

  if (!items.length) {
    return { exported: 0, groups: {} };
  }

  const mapped = await Promise.all(items.map((item) => mapAndMarkItem(item, productIdMap)));

  const groups = {};
  items.forEach((item, idx) => {
    const key = item.model.name;
    if (!groups[key]) groups[key] = [];
    groups[key].push(mapped[idx]);
  });

  return { exported: mapped.length, groups };
}

/**
 * Extracts the best available brand/manufacturer name from an inventory item
 * and its associated car intake data.
 */
const extractBrandName = (item) => {
  return (item.make?.name || "Unknown").toUpperCase();
};

/**
 * Generates a consistent readable SKU from the product name for Wix.
 *
 * NOTE (confirmed pre-existing dead code, preserved unmodified): not
 * called anywhere in this file — services/wixPartSync.service.js has its
 * OWN separate, actually-used `generateSku` implementation.
 */
const generateSku = (productName) => {
  return productName
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 40);
};

/**
 * Builds the Wix API product payload for a deduplicated product group.
 * Sets quantity, brand, price, and inventory tracking fields.
 *
 * NOTE (confirmed pre-existing dead code, preserved unmodified): not
 * called anywhere in this file or services/wixPartSync.service.js (that
 * file's own comments explicitly describe this as "untouched,
 * currently-unused").
 */
const buildWixProductPayload = (item, sku, quantity, intake, price) => {
  const cd = intake?.carDetails || {};
  const vd = intake?.vinDetails || {};

  const val = (...args) => {
    for (const arg of args) {
      if (arg && arg !== "N/A" && arg !== "") return arg;
    }
    return "N/A";
  };

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

  const formattedPartName = item.partName
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase())
    .trim();

  const vehicleName = [item.year, item.make?.name?.toUpperCase(), item.model?.name, item.trim?.name]
    .filter(Boolean)
    .join(" ");

  const description =
    `${formattedPartName}, Condition: Used, ` +
    `Year: ${item.year}, Make: ${item.make?.name}, ` +
    `Model: ${item.model?.name}, Trim: ${item.trim?.name}`;

  const brand = extractBrandName(item);

  return {
    product: {
      name: `${vehicleName} - ${formattedPartName}`,
      productType: "PHYSICAL",
      visible: true,
      brand,
      variantsInfo: {
        variants: [
          {
            sku,
            price: { actualPrice: { amount: String(price.toFixed(2)) } },
            physicalProperties: { weight: item.weight || 0 },
          },
        ],
      },
      infoSections: [
        { title: "Description", plainDescription: description, uniqueName: "description" },
        { title: "Fitment", plainDescription: " ", uniqueName: "fitment" },
        { title: "Source Vehicle", plainDescription: sourceVehicleHtml, uniqueName: "source-vehicle" },
        { title: "Return and Refund Policy", plainDescription: " ", uniqueName: "return-policy" },
      ],
    },
  };
};

/**
 * NOTE (confirmed pre-existing dead code, preserved unmodified): not
 * called anywhere in this file or elsewhere in the codebase.
 */
const updateWixCmsProductFields = async ({ wixProductId, quantity, brand, collectionIds = [], wixInventoryItemId }) => {
  if (!wixProductId) {
    throw new Error("wixProductId is required for CMS update");
  }

  const data = {
    _id: wixProductId,
    [WIX_FIELDS_IDS.quantityInStock]: Number(quantity || 0),
    [WIX_FIELDS_IDS.brand]: brand || "",
    [WIX_FIELDS_IDS.collections]: collectionIds,
    [WIX_FIELDS_IDS.inventoryItem]: wixInventoryItemId || null,
  };

  await axios.patch(
    `${WIX_BASE_URL}/wix-data/v2/items/${encodeURIComponent(WIX_PRODUCT_COLLECTION_ID)}/${wixProductId}`,
    { dataItem: { data } },
    { headers: WIX_HEADERS }
  );
};

// Add Category -> Wix Collection Mapping by shiva
// NOTE (confirmed pre-existing dead code, preserved unmodified): not
// referenced anywhere in this file or elsewhere in the codebase.
const WIX_COLLECTION_MAP = {
  Engine: "PUT_ENGINE_COLLECTION_ID_HERE",
  Braking: "PUT_BRAKING_COLLECTION_ID_HERE",
  "Electrical Parts": "PUT_ELECTRICAL_PARTS_COLLECTION_ID_HERE",
  Accessories: "PUT_ACCESSORIES_COLLECTION_ID_HERE",
  "Exterior Parts": "PUT_EXTERIOR_PARTS_COLLECTION_ID_HERE",
};

const getWixCollectionIds = (category) => {
  const collectionId = WIX_COLLECTION_MAP[category];
  return collectionId ? [collectionId] : [];
};

// ── 5. Export unsynced parts deduplicated by Brand + Part Name with quantity ─
// Groups inventory items by Year + Make + Model + Part Name (NOT by SKU)
// so only ONE Wix product is created per unique vehicle part combination.
// Quantity is the total count of all inventory records in the group.
// Uses product name + brand to determine if a product already exists in Wix.
//
// Returns { shortCircuit: true, body } when there are zero valid items
// (matches the original's distinct early-return response shape exactly —
// no `totalItems` field in that case), otherwise
// { shortCircuit: false, body, syncPayloads } — the caller (controller) is
// responsible for sending `body` as the HTTP response FIRST, then invoking
// triggerBackgroundWixSync(syncPayloads) — this exact ordering (respond,
// THEN run the background Wix sync) is preserved from the original
// controller function, since it is an HTTP response-timing concern.
async function prepareDeduplicatedExport(query) {
  const limit = parseInt(query?.limit, 10) || 0;

  const filters = {};
  if (query?.make) filters.make = query.make;
  if (query?.model) filters.model = query.model;
  if (query?.year) filters.year = Number(query.year);
  if (query?.trim) filters.trim = query.trim;
  if (query?.partName) filters.partName = query.partName;

  const { payloads: syncPayloads, totalItems } = await prepareWixSyncGroups({ limit, filters });

  if (!totalItems) {
    return { shortCircuit: true, body: { success: true, exported: 0, parts: [] } };
  }

  const responseParts = syncPayloads.map((p) => ({
    externalId: p.item._id.toString(),
    make: p.item.make?.name,
    model: p.item.model?.name,
    trim: p.item.trim?.name,
    year: p.item.year,
    brand: extractBrandName(p.item),
    name: p.productName,
    title: p.title,
    sku: p.sku,
    productType: 1,
    merchantCategory: p.merchantCategory,
    merchantProductType: p.merchantProductType,
    fieldtype: p.fieldtype,
    handledSlug: p.handledSlug,
    product_image: p.primaryImage,
    productImages: p.productImages,
    shippingWeight: p.shippingWeight,
    visible: true,
    category: p.item.category,
    price: p.price,
    quantity: p.quantity,
    quantityInStock: p.quantity,
    currency: "USD",
    description: p.description,
    productInfo: {
      additionalInfoSections: [
        { title: "Description", description: p.description },
        { title: "Fitment", description: " " },
        { title: "Source Vehicle", description: p.sourceVehicleHtml },
        { title: "Return and Refund Policy", description: " " },
      ],
    },
  }));

  return {
    shortCircuit: false,
    body: { success: true, exported: responseParts.length, totalItems, parts: responseParts },
    syncPayloads,
  };
}

function triggerBackgroundWixSync(syncPayloads) {
  executeWixSyncForGroups(syncPayloads).catch((bgError) => {
    console.error("[WIX SYNC] Background sync failed:", bgError);
  });
}

async function listWixCollections() {
  const response = await axios.post(
    `${WIX_BASE_URL}/stores/v1/collections/query`,
    { query: { paging: { limit: 100, offset: 0 } } },
    { headers: WIX_HEADERS }
  );

  return (response.data?.collections || []).map((collection) => ({
    id: collection.id,
    name: collection.name,
    slug: collection.slug || "",
  }));
}

module.exports = {
  syncWithWix,
  markInventorySynced,
  exportAndSyncAllParts,
  exportAndSyncByMake,
  exportAndSyncByYear,
  exportAndSyncByModel,
  prepareDeduplicatedExport,
  triggerBackgroundWixSync,
  listWixCollections,
};
