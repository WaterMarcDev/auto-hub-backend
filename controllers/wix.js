const Inventory = require("../models/Inventory.model");
const carInTake = require("../models/carInTake.model");

const { resolvePartPrice } = require("../utils/partPricing");
const { isGermanVehicle } = require("../utils/vehicleClassification");
const {
  resolvePartMetadata,
  resolveTemplate,
  splitImageUrls,
} = require("../utils/partSyncMetadata");
const { isWixExcludedPart } = require("../utils/wixExportExclusions");

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
    // all inventory where wixSync is true
    const unsyncedInventories = await Inventory.find({ wixSynced: false })     // wixSynced: false by shiva
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

    const fetchedItems = await Inventory.find({ wixSynced: false }).limit(10)
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

    const fetchedItems = await Inventory.find({ wixSynced: false })
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

    const fetchedItems = await Inventory.find({ wixSynced: false })
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

    const fetchedItems = await Inventory.find({ wixSynced: false })
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
 * Generates a stable, unique grouping key based on Year + Brand + Model + Part Name.
 * Products with the same key are considered identical and aggregated into one Wix product.
 */
const getGroupKey = (item) => {
  const year = item.year || "0000";
  const make = (item.make?.name || "Unknown").toUpperCase();
  const model = (item.model?.name || "Unknown").toUpperCase();
  const partName = item.partName
    .replace(/\s+/g, "")
    .replace(/^./, (c) => c.toLowerCase());
  return `${year}-${make}-${model}-${partName}`;
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
    // const axios = require("axios");
    // const WIX_HEADERS = {
    //   "Content-Type": "application/json",
    //   "Authorization": process.env.WIX_API_KEY,
    //   "wix-site-id": process.env.WIX_SITE_ID,
    // };

    // ── Limit: control how many items to process per sync ────────
    const limit = parseInt(req.query?.limit, 10) || 0;
    const query = Inventory.find({ wixSynced: false })
      .populate("make", "name")
      .populate("model", "name")
      .populate("trim", "name");

    if (limit > 0) {
      query.limit(limit);
    }

    const items = await query;

    // Check valid product details or not by shiva
    const validItems = items.filter((item) => {
      const isValid =
        item &&
        item._id &&
        item.partName &&
        item.make?._id &&
        item.model?._id &&
        item.trim?._id;

      if (!isValid) {
        console.warn("[WIX BACKGROUND] Skipping invalid inventory record:", {
          inventoryId: item?._id?.toString() || null,
          partName: item?.partName || null,
          make: item?.make || null,
          model: item?.model || null,
          trim: item?.trim || null,
        });
      }

      return isValid;
    });
    // end here

    if (!validItems.length) {
      return res.status(200).json({ success: true, exported: 0, parts: [] });
    }

    // Wix export boundary only — windShield/a1/a2 stay in Inventory/CRM,
    // they just never enter a Wix-bound payload. Any group made up entirely
    // of excluded parts simply never gets a key in groupMap below, so no
    // empty/invalid Wix product is ever built for it.
    const syncableItems = validItems.filter((item) => !isWixExcludedPart(item.partName));

    // ── Group unsynced items by Year + Make + Model + Part Name ──────────────
    const groupMap = {};
    for (const item of syncableItems) {
      const key = getGroupKey(item);
      if (!groupMap[key]) {
        groupMap[key] = [];
      }
      groupMap[key].push(item);
    }

    // ── Build sync payloads from local data (no Wix API calls yet) ──────────
    // Each entry: { productName, sku, price, quantity, item, intake, sourceVehicleHtml, description, groupItems }
    const syncPayloads = [];

    for (const [groupKey, groupItems] of Object.entries(groupMap)) {
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

      const productName = `${vehicleName} - ${formattedPartName}`;
      const sku = generateSku(productName);

      const intake = await carInTake.findOne({ vin: item.vin }).lean();

      const { price } = resolvePartPrice({
        partName: item.partName,
        isGerman: isGermanVehicle(item.make?.name),
      });

      const totalQuantity = await Inventory.countDocuments({
        make: item.make._id,
        model: item.model._id,
        year: item.year,
        partName: item.partName,
        isDeleted: false,
      });
      const quantity = totalQuantity;

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

      // Existing inline-built description — kept exactly as-is and used as
      // the fallback when the CSV has no matching row for this part (this
      // was already the ONLY description behavior before this change, so
      // "fallback" here means "unchanged pre-existing behavior", not a new
      // invention).
      const fallbackDescription = `${formattedPartName}, Condition: Used, ` +
        `Year: ${item.year}, Make: ${item.make?.name}, ` +
        `Model: ${item.model?.name}, Trim: ${item.trim?.name}`;

      // CSV-sourced product metadata (description/image/slug/category/
      // productType). Matched by the exact same part key pricing already
      // uses, so a part's price and its metadata always come from the same
      // CSV row — see utils/partSyncMetadata.js.
      const csvMeta = resolvePartMetadata({ partName: item.partName });

      const description = csvMeta.found
        ? resolveTemplate(csvMeta.descriptionTemplate, {
            year: item.year,
            make: item.make?.name,
            model: item.model?.name,
          })
        : fallbackDescription;

      const productImages = csvMeta.found
        ? splitImageUrls(csvMeta.productImageUrl)
        : [];
      const primaryImage = productImages[0] || undefined;

      // Business-constant Google Merchant fields. CSV-sourced when a row
      // matches (the CSV's own productType/category columns already carry
      // exactly these business values for every row); fall back to the same
      // constants directly when no CSV row matches, so this never regresses
      // to "missing" for a part price already resolves for via the legacy
      // JSON fallback.
      const merchantProductType = csvMeta.productType || "Auto Part";
      const merchantCategory = csvMeta.category || "Used Auto Parts";
      // Distinct business concept from productType/category above — see the
      // "Fieldtype" clarification: this is always the constant "Product",
      // never derived from the CSV (the CSV has no such column).
      const fieldtype = "Product";

      // Deterministic slug: CSV's part-level handleIdSlug combined with the
      // vehicle so each distinct Year+Make+Model+Part product (this sync's
      // own grouping key, see getGroupKey()) gets a unique slug — the base
      // handleIdSlug alone (e.g. "front-bumper") would collide across every
      // vehicle that has that same part. Omitted (not invented) when no CSV
      // row matches, since there is no part-level base slug to build from.
      const handledSlug = csvMeta.found
        ? [csvMeta.handleIdSlug, item.year, item.make?.name, item.model?.name]
            .filter(Boolean)
            .join("-")
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")
        : undefined;

      // Business-required Title, distinct from `name`/productName above and
      // NOT sent as a replacement for it — Wix's own product-name field
      // keeps using productName exactly as before. Format is fixed by the
      // business: "{Year} {Make} {Model}(Used, Good Condition)" (no space
      // before the parenthesis). Falls back to VIN-decoded vinDetails and
      // then "N/A" using the same val() convention already used for the
      // Source Vehicle section above, rather than inventing a value.
      const title = `${val(item.year, vd.ModelYear)} ${val(item.make?.name, vd.Make)} ${val(item.model?.name, vd.Model)}(Used, Good Condition)`;

      // Shipping Weight — authoritative source is the CSV's own
      // "Weight (lbs)" column (see utils/partSyncMetadata.js), matched via
      // the SAME csvMeta lookup already used for description/image/slug/
      // category/productType above, so weight never disagrees with a part's
      // other metadata about which CSV row it came from. Undefined (never
      // invented, never sourced from Inventory.weight) when no CSV row
      // matches or the CSV's weight value is missing/invalid.
      const shippingWeight = csvMeta.weightLbs;

      syncPayloads.push({
        productName,
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
        handledSlug,
        shippingWeight,
        formattedPartName,
        groupItems,
      });
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

    const totalItems = validItems.length;
    const exportedCount = responseParts.length;

    // Send response first — background Wix sync continues after
    res.status(200).json({
      success: true,
      exported: exportedCount,
      totalItems,
      parts: responseParts,
    });

    // ── Background: sync with Wix API (runs after response is sent) ────────
    try {
      console.log(`[WIX BACKGROUND] Starting Wix sync for ${exportedCount} product groups (${totalItems} items)...`);

      // Build name → existing Wix ID map by querying Wix
      // const nameToWixId = {};
      // const productNames = syncPayloads.map((p) => p.productName);
      // const WIX_BATCH_SIZE = 50;

      // for (let i = 0; i < productNames.length; i += WIX_BATCH_SIZE) {
      //   const batchNames = productNames.slice(i, i + WIX_BATCH_SIZE);
      //   try {
      //     const queryResp = await axios.post(
      //       "https://www.wixapis.com/stores/v3/products/query",
      //       {
      //         query: {
      //           filter: { name: { $in: batchNames } },
      //           fields: ["id", "name"],
      //         },
      //       },
      //       { headers: WIX_HEADERS }
      //     );
      //     const existingProducts = queryResp.data?.products || [];
      //     for (const prod of existingProducts) {
      //       if (prod.name) nameToWixId[prod.name] = prod.id;
      //     }
      //   } catch (queryErr) {
      //     console.error("[WIX BACKGROUND] Query error for name batch:", queryErr.response?.data || queryErr.message);
      //   }
      // }

      // Wix Catalog V3 does not support filtering products by name.
      // CRM records are marked wixSynced only after Wix product + Velo sync succeed.
      const nameToWixId = {};

      console.log(
        "[WIX BACKGROUND] EXISTING PRODUCTS FOUND:",
        Object.keys(nameToWixId).length
      );

      console.log("[WIX BACKGROUND] PRODUCT NAMES:",
        Object.keys(nameToWixId)
      );

      // Process each group: update if exists, create if new
      let syncedCount = 0;
      let errorCount = 0;

      for (const p of syncPayloads) {
        const existingWixId = nameToWixId[p.productName];
        let resolvedWixProductId = existingWixId || p.item._id.toString();

        try {
          // let pid =
          //   p.groupItems.find((groupItem) => groupItem.wixProductId)?.wixProductId ||
          //   existingWixId ||
          //   null;

          // if (pid) {
          //   console.log(
          //     `[WIX BACKGROUND] Syncing existing Wix product ${pid} through Velo`
          //   );

          //   await syncProductFieldsThroughVelo({
          //     productId: pid,
          //     brand: extractBrandName(p.item),
          //     category: p.item.category,
          //     quantity: p.quantity,
          //   });

          //   console.log(`[WIX BACKGROUND] Existing Wix product synced: ${pid}`);
          // } 
          let pid =
            p.groupItems.find(
              (groupItem) =>
                  groupItem.wixProductId &&
              groupItem.wixProductId !== "null" &&
              groupItem.wixProductId !== "undefined"
            )?.wixProductId || null;
          
          let productWasCreated = false;
          if (pid) {
            try {
              console.log(
                `[WIX BACKGROUND] Syncing existing Wix product ${pid} through Velo`
              );

              await syncProductFieldsThroughVelo({
                productId: pid,
                brand: extractBrandName(p.item),
                category: p.item.category,
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

              console.log(`[WIX BACKGROUND] Existing Wix product synced: ${pid}`);
            } catch (existingProductError) {
              const wixErrorMessage =
                existingProductError.response?.data?.error ||
                existingProductError.message ||
                "";

              const productNotFound =
                existingProductError.response?.status === 500 &&
                wixErrorMessage.includes("was not found");

              if (!productNotFound) {
                throw existingProductError;
              }

              console.warn(
                  `[WARN BACKGROUND] Stored Wix ID ${pid} no longer exists in Wix. Creating a new product instead.`
              );

              pid = null;
            }
          }
          if (!pid) {
            const veloBaseUrl = String(process.env.WIX_VELO_BASE_URL || "").replace(
              /\/$/,
              ""
            );

            if (!veloBaseUrl) {
              throw new Error("WIX_VELO_BASE_URL is missing in .env");
            }

            if (!process.env.PART_SYNC_SECRET) {
              throw new Error("PART_SYNC_SECRET is missing in .env");
            }

            console.log(
              `[WIX BACKGROUND] Sending "${p.productName}" to Wix Velo for creation`
            );

            const veloResponse = await axios.post(
              `${veloBaseUrl}/_functions/partSync`,
              {
                secret: process.env.PART_SYNC_SECRET,
                productName: p.productName,
                title: p.title,
                sku: p.sku,
                price: Number(p.price || 0),
                brand: extractBrandName(p.item),
                category: p.item.category || "Uncategorized",
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
              {
                headers: {
                  "Content-Type": "application/json",
                },
                timeout: 30000,
              }
            );

            const veloData = veloResponse.data;

            if (!veloData?.success || !veloData?.productId) {
              throw new Error(
                `Wix Velo create failed: ${veloData?.error || "No productId returned"}`
              );
            }

            pid = veloData.productId;
            productWasCreated = true;

            console.log(`[WIX BACKGROUND] Velo created Wix product ${pid}`);
          }

          // Mark all CRM inventory records in this group as synced only AFTER
          // product + Wix Velo fields are both successful.
          for (const gItem of p.groupItems) {
            await Inventory.findByIdAndUpdate(gItem._id, {
              wixSynced: true,
              wixSyncedAt: new Date(),
              wixProductId: pid,
            });
          }

          syncedCount++;
        } catch (wixErr) {
          errorCount++;
          console.error(`[WIX BACKGROUND] Wix API error for "${p.productName}":`, {
            status: wixErr.response?.status,
            statusText: wixErr.response?.statusText,
            data: wixErr.response?.data,
            headers: wixErr.response?.headers,
            message: wixErr.message,
            stack: wixErr.stack,
          });
        }
      }

      console.log(`[WIX BACKGROUND] Sync complete: ${syncedCount} success, ${errorCount} errors.`);
    } catch (bgError) {
      console.error("[WIX BACKGROUND] Background sync failed:", bgError);
    }
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