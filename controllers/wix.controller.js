const Inventory = require("../models/Inventory.model");
const carInTake = require("../models/CarIntake.model");

const { resolvePartPrice } = require("../utils/partPricing");
const { isGermanVehicle } = require("../utils/vehicleClassification");
const { isWixExcludedPart } = require("../utils/wixExportExclusions");

// Canonical deduplicated-sync engine (see services/wixPartSync.service.js).
// exportAndSyncDeduplicated below delegates its actual selection/grouping/
// Wix-create-or-update logic to these — this file only owns the HTTP
// request/response shape for that endpoint now.
const {
  prepareWixSyncGroups,
  executeWixSyncForGroups,
} = require("../services/wixPartSync.service");

// Connecting wix inventory and collection by shiva

const axios = require("axios");

const WIX_BASE_URL = "https://www.wixapis.com";

const WIX_HEADERS = {
  "Content-Type": "application/json",

  // Existing Wix token
  Authorization: process.env.WIX_API_KEY,

  "wix-meta-site-id": process.env.WIX_SITE_ID,

};

// Call the Wix Velo HTTP function. by shiva
// This runs inside the Wix site, so it has the required Wix site context.
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
  const veloUrl = `${String(process.env.WIX_VELO_BASE_URL || "").replace(
    /\/$/,
    ""
  )}/_functions/partSync`;

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
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );

  if (!response.data?.success) {
    throw new Error(
      response.data?.error || "Wix Velo part-sync returned an error"
    );
  }

  return response.data;
};
// end here


// Wix CMS Products collection fields from your screenshots
const WIX_PRODUCT_COLLECTION_ID = "Stores/Products";

const WIX_FIELDS_IDS = {
  quantityInStock: "quantityInStock",
  collections: "collections",
  brand: "brand",
  inventoryItem: "inventoryItem",
};
// end here

const syncWithWix = async (req, res) => {
  try {
    // Active Inventory is the source of truth: exclude soft-deleted records,
    // and treat "not yet synced" as wixSynced !== true (covers legacy docs
    // stored before the wixSynced field existed, which have no such key and
    // would never match a strict `wixSynced: false` equality query).
    const unsyncedInventories = await Inventory.find({
      isDeleted: { $ne: true },
      wixSynced: { $ne: true },
    })
      .populate("make", "name")
      .populate("model", "name")
      .populate("trim", "name");

    // Wix export boundary only — windShield/a1/a2 stay in Inventory/CRM,
    // they just never enter a Wix-bound payload.
    const inventoriesToSync = unsyncedInventories.filter(
      (item) => !isWixExcludedPart(item.partName)
    );

    console.log("UNSYNCED INVENTORIES:", inventoriesToSync.length);   //temp debug by shiva
    // Prepare data for Wix
    const wixData = inventoriesToSync.map((item) => ({
      name: item.partName
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, (str) => str.toUpperCase())
        .trim(),
      sku:
        item.sku &&
          !item.sku.includes("${") &&
          item.sku.length <= 40
          ? item.sku.substring(0, 40)
          : item._id.toString(),
      // item.sku
      //   ? item.sku.substring(0, 40)
      //   : item._id.toString(),

      productType: "physical",
      price: 1,
      // price: 0,
      visible: false,
      slug: `${item.make.name}-${item.model.name}-${item.trim.name
        }-${item.partName.replace(/([A-Z])/g, "-$1").replace(/^-/, "")}-${item.year
        }`,
      brand: item.make.name,
      category: item.category,   //added by shiva

      customTextFields: [
        { title: "externalId", value: item._id.toString() },
        { title: "make", value: item.make.name },
        { title: "model", value: item.model.name },
        { title: "trim", value: item.trim.name },
        { title: "year", value: item.year.toString() },
      ],
      // customTextFields: [
      //   { externalId: item._id.toString() },
      //   { make: item.make.name },
      //   { model: item.model.name },
      //   { trim: item.trim.name },
      //   { year: item.year.toString() },
      // ],
      currency: "USD",
    }));

    // send wixData in response and mark items as synced
    // for (const item of inventoriesToSync) {
    //   item.wixSynced = false;     //uncommented by shiva
    //   item.wixSyncedAt = new Date();
    //   await item.save();
    // }

    // Temp. Debug by shiva
    console.log("WIX PRODUCTS COUNT:", wixData.length);

    if (wixData.length) {
      console.log(
        "FIRST PRODUCT:",
        JSON.stringify(wixData[0], null, 2)
      );
    }
    // end here

    res.status(200).json(wixData);   // added by shiva
    // res.status(200).json({ syncedItems: wixData });
  } catch (error) {
    console.error("Error syncing with Wix:", error);
    res
      .status(500)
      .json({ error: "An error occurred while syncing with Wix." });
  }
};

// Mark Inventory Synced Route by shiva
const markInventorySynced = async (req, res) => {
  try {
    console.log("MARK INVENTORY SYNCED CALLED");
    console.log("PATCH BODY:", req.body);
    console.log("INVENTORY ID:", req.params.inventoryId);
    console.log("WIX PRODUCT ID:", req.body.wixProductId);


    const inventory = await Inventory.findByIdAndUpdate(
      req.params.inventoryId,
      {
        wixSynced: true,
        wixSyncedAt: new Date(),
        wixProductId: req.body.wixProductId
      },
      { new: true }
    );

    console.log("UPDATED INVENTORY:", JSON.stringify(inventory, null, 2));

    if (!inventory) {
      return res.status(404).json({
        success: false,
        error: "Inventory not found"
      });
    }

    return res.status(200).json({
      success: true,
      inventoryId: inventory._id,
    });
  } catch (error) {

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
// end here

// ─────────────────────────────────────────────────────────────────────────────
// NEW EXPORT + MARK-SYNCED ENDPOINTS  (appended – do not modify above)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shared helper: maps an Inventory document to the Wix product shape
 * and marks the document as synced (wixSynced, wixProductId, wixSyncedAt).
 * wixProductId is taken from req.body.productIdMap[item._id] if provided,
 * otherwise falls back to item._id.toString().
 */
const mapAndMarkItem = async (item, productIdMap = {}) => {
  const wixProductId =
    productIdMap[item._id.toString()] || item._id.toString();

  // Mark synced in DB
  // await Inventory.findByIdAndUpdate(item._id, {
  //   wixSynced: true,
  //   wixSyncedAt: new Date(),
  //   wixProductId,
  // });

  const intake = await carInTake.findOne({
    vin: item.vin,
  }).lean();

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

  const vehicleName = [
    item.year,
    item.make?.name?.toUpperCase(),
    item.model?.name,
    item.trim?.name,
  ]
    .filter(Boolean)
    .join(" ");

  const description =
    `${formattedPartName}, Condition: Used, Part Number: 123456789, ` +
    `Year: ${item.year}, Make: ${item.make?.name}, ` +
    `Model: ${item.model?.name}, Trim: ${item.trim?.name}, Body: SUV`;

  return {
    externalId: item._id.toString(),
    wixProductId,

    // name: item.partName
    //   .replace(/([A-Z])/g, " $1")
    //   .replace(/^./, (str) => str.toUpperCase())
    //   .trim(),

    make: item.make?.name,
    model: item.model?.name,
    trim: item.trim?.name,
    year: item.year,

    weight: item.weight,

    name: `${vehicleName} - ${formattedPartName}`,

    sku:
      item.sku &&
        !item.sku.includes("${") &&
        item.sku.length <= 40
        ? item.sku.substring(0, 40)
        : item._id.toString(),
    productType: 1,
    visible: false,
    brand: item.make.name,
    category: item.category,
    price,
    // slug: `${item.make.name}-${item.model.name}-${
    //   item.trim.name
    // }-${item.partName.replace(/([A-Z])/g, "-$1").replace(/^-/, "")}-${
    //   item.year
    // }`,
    // customTextFields: [
    //   { title: "externalId", value: item._id.toString() },
    //   { title: "make",       value: item.make.name },
    //   { title: "model",      value: item.model.name },
    //   { title: "trim",       value: item.trim.name },
    //   { title: "year",       value: item.year.toString() },
    // ],
    currency: "USD",

    description,

    productInfo: {
      additionalInfoSections: [
        {
          title: "Description",
          description,
        },
        {
          title: "Fitment",
          description: "",
        },
        {
          title: "Source Vehicle",
          description: sourceVehicleHtml,
        },
        {
          title: "Return and Refund Policy",
          description: "",
        },
      ],
    },
  };
};

// ── 1. Export ALL unsynced parts & mark them synced ──────────────────────────
// POST /api/wix/export/parts
// Body (optional): { productIdMap: { "<inventoryId>": "<wixProductId>", ... } }
const exportAndSyncAllParts = async (req, res) => {
  try {
    const productIdMap = req.body?.productIdMap || {};

    // Active Inventory is the source of truth: exclude soft-deleted records.
    // Previously capped at .limit(10) — that silently truncated this
    // "export ALL unsynced parts" endpoint to 10 records regardless of how
    // many were actually eligible; removed to match the identical (unlimited)
    // query shape already used by the sibling by-make/by-year/by-model
    // endpoints below.
    const fetchedItems = await Inventory.find({
      isDeleted: { $ne: true },
      wixSynced: { $ne: true },
    })
      .populate("make", "name")
      .populate("model", "name")
      .populate("trim", "name");

    // Wix export boundary only — windShield/a1/a2 stay in Inventory/CRM,
    // they just never enter a Wix-bound payload.
    const items = fetchedItems.filter((item) => !isWixExcludedPart(item.partName));

    if (!items.length) {
      return res.status(200).json({
        success: true,
        exported: 0,
        parts: [],
      });
    }

    const parts = await Promise.all(
      items.map((item) => mapAndMarkItem(item, productIdMap))
    );

    return res.status(200).json({
      success: true,
      exported: parts.length,
      parts,
    });
  } catch (error) {
    console.error("exportAndSyncAllParts error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// ── 2. Export unsynced parts grouped by Make & mark them synced ──────────────
// POST /api/wix/export/parts/by-make
const exportAndSyncByMake = async (req, res) => {
  try {
    const productIdMap = req.body?.productIdMap || {};

    // Active Inventory is the source of truth: exclude soft-deleted records,
    // and treat "not yet synced" as wixSynced !== true (covers legacy docs
    // with no wixSynced field at all).
    const fetchedItems = await Inventory.find({
      isDeleted: { $ne: true },
      wixSynced: { $ne: true },
    })
      .populate("make", "name")
      .populate("model", "name")
      .populate("trim", "name");

    // Wix export boundary only — windShield/a1/a2 stay in Inventory/CRM,
    // they just never enter a Wix-bound payload.
    const items = fetchedItems.filter((item) => !isWixExcludedPart(item.partName));

    if (!items.length) {
      return res.status(200).json({ success: true, exported: 0, groups: {} });
    }

    const mapped = await Promise.all(
      items.map((item) => mapAndMarkItem(item, productIdMap))
    );

    // Group by make name
    const groups = {};
    items.forEach((item, idx) => {
      const key = item.make.name;
      if (!groups[key]) groups[key] = [];
      groups[key].push(mapped[idx]);
    });

    return res.status(200).json({
      success: true,
      exported: mapped.length,
      groups,
    });
  } catch (error) {
    console.error("exportAndSyncByMake error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// ── 3. Export unsynced parts grouped by Year & mark them synced ──────────────
// POST /api/wix/export/parts/by-year
const exportAndSyncByYear = async (req, res) => {
  try {
    const productIdMap = req.body?.productIdMap || {};

    // Active Inventory is the source of truth: exclude soft-deleted records,
    // and treat "not yet synced" as wixSynced !== true (covers legacy docs
    // with no wixSynced field at all).
    const fetchedItems = await Inventory.find({
      isDeleted: { $ne: true },
      wixSynced: { $ne: true },
    })
      .populate("make", "name")
      .populate("model", "name")
      .populate("trim", "name");

    // Wix export boundary only — windShield/a1/a2 stay in Inventory/CRM,
    // they just never enter a Wix-bound payload.
    const items = fetchedItems.filter((item) => !isWixExcludedPart(item.partName));

    if (!items.length) {
      return res.status(200).json({ success: true, exported: 0, groups: {} });
    }

    const mapped = await Promise.all(
      items.map((item) => mapAndMarkItem(item, productIdMap))
    );

    // Group by year
    const groups = {};
    items.forEach((item, idx) => {
      const key = String(item.year);
      if (!groups[key]) groups[key] = [];
      groups[key].push(mapped[idx]);
    });

    return res.status(200).json({
      success: true,
      exported: mapped.length,
      groups,
    });
  } catch (error) {
    console.error("exportAndSyncByYear error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// ── 4. Export unsynced parts grouped by Model & mark them synced ─────────────
// POST /api/wix/export/parts/by-model
const exportAndSyncByModel = async (req, res) => {
  try {
    const productIdMap = req.body?.productIdMap || {};

    // Active Inventory is the source of truth: exclude soft-deleted records,
    // and treat "not yet synced" as wixSynced !== true (covers legacy docs
    // with no wixSynced field at all).
    const fetchedItems = await Inventory.find({
      isDeleted: { $ne: true },
      wixSynced: { $ne: true },
    })
      .populate("make", "name")
      .populate("model", "name")
      .populate("trim", "name");

    // Wix export boundary only — windShield/a1/a2 stay in Inventory/CRM,
    // they just never enter a Wix-bound payload.
    const items = fetchedItems.filter((item) => !isWixExcludedPart(item.partName));

    if (!items.length) {
      return res.status(200).json({ success: true, exported: 0, groups: {} });
    }

    const mapped = await Promise.all(
      items.map((item) => mapAndMarkItem(item, productIdMap))
    );

    // Group by model name
    const groups = {};
    items.forEach((item, idx) => {
      const key = item.model.name;
      if (!groups[key]) groups[key] = [];
      groups[key].push(mapped[idx]);
    });

    return res.status(200).json({
      success: true,
      exported: mapped.length,
      groups,
    });
  } catch (error) {
    console.error("exportAndSyncByModel error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Extracts the best available brand/manufacturer name from an inventory item
 * and its associated car intake data.
 */
const extractBrandName = (item) => {
  return (item.make?.name || "Unknown").toUpperCase();
};

/**
 * Generates a consistent readable SKU from the product name for Wix.
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

  const vehicleName = [
    item.year,
    item.make?.name?.toUpperCase(),
    item.model?.name,
    item.trim?.name,
  ]
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
      // stock: {
      //   quantity,
      //   unlimited: false,
      //   trackQuantity: true,
      //   quantityInStock: quantity,
      //   trackInventory: true,
      //   inventoryAndShipping: {
      //     trackInventory: true,
      //     onlineStoreInventory: quantity,
      //   },
      // },
      variantsInfo: {
        variants: [
          {
            sku,
            price: {
              actualPrice: {
                amount: String(price.toFixed(2)),
              },
            },
            physicalProperties: {
              weight: item.weight || 0,
            },
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

// ── 5. Export unsynced parts deduplicated by Brand + Part Name with quantity ─
// POST /api/wix/export/parts/deduplicated
// Groups inventory items by Year + Make + Model + Part Name (NOT by SKU)
// so only ONE Wix product is created per unique vehicle part combination.
// Quantity is the total count of all inventory records in the group.
// Responds immediately with summary; Wix API calls run in background.
// Uses product name + brand to determine if a product already exists in Wix.

// Helper Function to update wix by shiva
const updateWixCmsProductFields = async ({
  wixProductId,
  quantity,
  brand,
  collectionIds = [],
  wixInventoryItemId,
}) => {
  if (!wixProductId) {
    throw new Error("wixProductId is required for CMS update");
  }

  const data = {
    _id: wixProductId,

    // Your Wix CMS custom field
    [WIX_FIELDS_IDS.quantityInStock]: Number(quantity || 0),

    // Your Wix CMS custom Brand Field
    [WIX_FIELDS_IDS.brand]: brand || "",

    // Your Wix CMS Multi-Reference Collections field
    [WIX_FIELDS_IDS.collections]: collectionIds,

    // Wix Inventory Item reference field
    [WIX_FIELDS_IDS.inventoryItem]: wixInventoryItemId || null,

  };

  await axios.patch(
    `${WIX_BASE_URL}/wix-data/v2/items/${encodeURIComponent(
      WIX_PRODUCT_COLLECTION_ID
    )}/${wixProductId}`,
    {
      dataItem: {
        data,
      },
    },
    {
      headers: WIX_HEADERS,
    }
  );
};
// end here  

// Add Category -> wWix Collection Mapping by shiva
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
// end here


const exportAndSyncDeduplicated = async (req, res) => {
  try {
    // ── Limit: control how many items to process per sync ────────
    const limit = parseInt(req.query?.limit, 10) || 0;

    // Canonical prepare phase (selection -> validity -> exclusion ->
    // Year+Make+Model+Trim+Part identity grouping -> per-group payload
    // construction). No Wix API calls and no DB writes happen here — see
    // services/wixPartSync.service.js for the full behavioral notes on
    // what changed (Trim added to identity) and what didn't (everything
    // else, carried over field-for-field from the original inline logic
    // that used to live in this function).

    const filters = {};
    
    if (req.query?.make) filters.make = req.query.make;
    if (req.query?.model) filters.model = req.query.model;
    if (req.query?.year) filters.year = Number(req.query.year);
    if (req.query?.trim) filters.trim = req.query.trim;
    if (req.query?.partName) filters.partName = req.query.partName;

    const { payloads: syncPayloads, totalItems } = await prepareWixSyncGroups({ limit, filters });

    // Matches the original early-return exactly: zero VALID (not
    // necessarily zero syncable) inventory records short-circuits with no
    // `totalItems` field, distinct from the normal-path response below
    // which always includes `totalItems` even when it's 0.
    if (!totalItems) {
      return res.status(200).json({ success: true, exported: 0, parts: [] });
    }

    // ── Respond immediately with the prepared data ──────────────────────────
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
      // New Google-Merchant-facing business fields. Named distinctly from
      // the existing `category`/`productType` keys above (which represent
      // the CRM's own part-category taxonomy and Wix's PHYSICAL/1 product
      // classification respectively) so this addition never overwrites
      // those already-working values.
      merchantCategory: p.merchantCategory,
      merchantProductType: p.merchantProductType,
      fieldtype: p.fieldtype,
      // HandledSlug (deterministic, undefined when no CSV row matched —
      // never a random/invented value) and product image(s) from the CSV.
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

    const exportedCount = responseParts.length;

    // Send response first — background Wix sync continues after. Preserves
    // the exact response shape/timing of the original implementation.
    res.status(200).json({
      success: true,
      exported: exportedCount,
      totalItems,
      parts: responseParts,
    });

    // ── Background: sync with Wix API (runs after response is sent) ────────
    // Canonical execute phase: per-group existence check (fresh DB read,
    // not a stale in-memory snapshot) -> update-or-create via Wix Velo,
    // recreating on a stale stored ID -> persist wixSynced/wixProductId
    // only after Wix succeeds. Serialized per product identity so two
    // overlapping sync runs can never both create a product for the same
    // identity — see services/wixPartSync.service.js for full details.
    executeWixSyncForGroups(syncPayloads).catch((bgError) => {
      console.error("[WIX SYNC] Background sync failed:", bgError);
    });
  } catch (error) {
    // If response has already been sent, just log; otherwise send error response
    if (res.headersSent) {
      console.error("exportAndSyncDeduplicated error (after response sent):", error);
    } else {
      console.error("exportAndSyncDeduplicated error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }
};

// Get Wix Collections by shiva
const listWixCollections = async (req, res) => {
  try {
    const response = await axios.post(
      `${WIX_BASE_URL}/stores/v1/collections/query`,
      {
        query: {
          paging: {
            limit: 100,
            offset: 0,
          },
        },
      },
      {
        headers: WIX_HEADERS,
      }
    );

    const collections = (response.data?.collections || []).map((collection) => ({
      id: collection.id,
      name: collection.name,
      slug: collection.slug || "",
    }));

    return res.status(200).json({
      success: true,
      count: collections.length,
      collections,
    });
  } catch (error) {
    console.error(
      "Wix Stores collections error:",
      error.response?.data || error.message
    );

    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
};
// end here

module.exports = {
  syncWithWix,
  markInventorySynced,            // added by shiva
  exportAndSyncAllParts,          // new
  exportAndSyncByMake,            // new
  exportAndSyncByYear,            // new
  exportAndSyncByModel,           // new
  exportAndSyncDeduplicated,      // new – deduplicated by Year+Make+Model+PartName with quantity
  listWixCollections,
};