const Inventory = require("../models/Inventory.model");
const carInTake = require("../models/carInTake.model");

const PART_PRICES = require("../assets/part_prices.json");

const syncWithWix = async (req, res) => {
  try {
    // all inventory where wixSync is true
    const inventoriesToSync = await Inventory.find({ wixSynced: false })     // wixSynced: false by shiva
      .populate("make", "name")
      .populate("model", "name")
      .populate("trim", "name");

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
      slug: `${item.make.name}-${item.model.name}-${
        item.trim.name
      }-${item.partName.replace(/([A-Z])/g, "-$1").replace(/^-/, "")}-${
        item.year
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

  const partKey = item.partName
    .replace(/\s+/g, "")
    .replace(/^./, c => c.toLowerCase());
  
  const price = PART_PRICES[partKey] || 0;

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

    const items = await Inventory.find({ wixSynced: false }).limit(10)
      .populate("make",  "name")
      .populate("model", "name")
      .populate("trim",  "name");

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

    const items = await Inventory.find({ wixSynced: false })
      .populate("make",  "name")
      .populate("model", "name")
      .populate("trim",  "name");

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

    const items = await Inventory.find({ wixSynced: false })
      .populate("make",  "name")
      .populate("model", "name")
      .populate("trim",  "name");

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

    const items = await Inventory.find({ wixSynced: false })
      .populate("make",  "name")
      .populate("model", "name")
      .populate("trim",  "name");

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
      // Stock/quantity for inventory tracking - maps to Inventory & Shipping > Online Store Inventory
      stock: {
        quantity,
        unlimited: false,
        trackQuantity: true,
        quantityInStock: quantity,
        trackInventory: true,
        inventoryAndShipping: {
          trackInventory: true,
          onlineStoreInventory: quantity,
        },
      },
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
const exportAndSyncDeduplicated = async (req, res) => {
  try {
    const axios = require("axios");
    const WIX_HEADERS = {
      "Content-Type": "application/json",
      "Authorization": process.env.WIX_API_KEY,
      "wix-site-id": process.env.WIX_SITE_ID,
    };

    // ── Limit: control how many items to process per sync ────────
    const limit = parseInt(req.query?.limit, 10) || 0;
    const query = Inventory.find({ wixSynced: false })
      .populate("make",  "name")
      .populate("model", "name")
      .populate("trim",  "name");

    if (limit > 0) {
      query.limit(limit);
    }

    const items = await query;

    if (!items.length) {
      return res.status(200).json({ success: true, exported: 0, parts: [] });
    }

    // ── Group unsynced items by Year + Make + Model + Part Name ──────────────
    const groupMap = {};
    for (const item of items) {
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

      const partKey = item.partName
        .replace(/\s+/g, "")
        .replace(/^./, (c) => c.toLowerCase());
      const price = PART_PRICES[partKey] || 0;

      const totalQuantity = await Inventory.countDocuments({
        make: item.make._id,
        model: item.model._id,
        year: item.year,
        partName: item.partName,
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

      const description = `${formattedPartName}, Condition: Used, ` +
        `Year: ${item.year}, Make: ${item.make?.name}, ` +
        `Model: ${item.model?.name}, Trim: ${item.trim?.name}`;

      syncPayloads.push({
        productName,
        sku,
        price,
        quantity,
        item,
        intake,
        sourceVehicleHtml,
        description,
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
      sku: p.sku,
      productType: 1,
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

    const totalItems = items.length;
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
      const nameToWixId = {};
      const productNames = syncPayloads.map((p) => p.productName);
      const WIX_BATCH_SIZE = 50;

      for (let i = 0; i < productNames.length; i += WIX_BATCH_SIZE) {
        const batchNames = productNames.slice(i, i + WIX_BATCH_SIZE);
        try {
          const queryResp = await axios.post(
            "https://www.wixapis.com/stores/v3/products/query",
            {
              query: {
                filter: `{"name": {"$in": ${JSON.stringify(batchNames)}}}`,
                fields: ["id", "name"],
              },
            },
            { headers: WIX_HEADERS }
          );
          const existingProducts = queryResp.data?.products || [];
          for (const prod of existingProducts) {
            if (prod.name) nameToWixId[prod.name] = prod.id;
          }
        } catch (queryErr) {
          console.error("[WIX BACKGROUND] Query error for name batch:", queryErr.response?.data || queryErr.message);
        }
      }
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
          if (existingWixId) {
            // Update existing product
            let currentQty = 0;
            try {
              const getResp = await axios.get(
                `https://www.wixapis.com/stores/v3/products/${existingWixId}`,
                { headers: WIX_HEADERS }
              );
              currentQty = getResp.data?.product?.stock?.quantity || 0;
            } catch (getErr) {
              console.log(`[WIX BACKGROUND] Could not fetch current qty for ${existingWixId}`);
            }

            const newQuantity = p.quantity;
            console.log(`[WIX BACKGROUND] Updating "${p.productName}" qty ${currentQty} → ${newQuantity}`);

            await axios.patch(
              `https://www.wixapis.com/stores/v3/products/${existingWixId}`,
              {
                product: {
                  name: p.productName,
                  productType: "PHYSICAL",
                  visible: true,
                  brand: extractBrandName(p.item),
                  stock: {
                    quantity: newQuantity,
                    unlimited: false,
                    trackQuantity: true,
                    quantityInStock: newQuantity,
                    trackInventory: true,
                    inventoryAndShipping: {
                      trackInventory: true,
                      onlineStoreInventory: newQuantity,
                    },
                  },
                  variantsInfo: {
                    variants: [
                      {
                        sku: p.sku,
                        price: { actualPrice: { amount: String(p.price.toFixed(2)) } },
                        physicalProperties: { weight: p.item.weight || 0 },
                      },
                    ],
                  },
                  infoSections: [
                    { title: "Description", plainDescription: p.description, uniqueName: "description" },
                    { title: "Fitment", plainDescription: " ", uniqueName: "fitment" },
                    { title: "Source Vehicle", plainDescription: p.sourceVehicleHtml, uniqueName: "source-vehicle" },
                    { title: "Return and Refund Policy", plainDescription: " ", uniqueName: "return-policy" },
                  ],
                },
              },
              { headers: WIX_HEADERS }
            );
            console.log(`[WIX BACKGROUND] Updated ${existingWixId}`);
            resolvedWixProductId = existingWixId;
          } else {
            // Create new product
            const wixPayload = buildWixProductPayload(p.item, p.sku, p.quantity, p.intake, p.price);
            console.log(`[WIX BACKGROUND] Creating "${p.productName}" qty ${p.quantity}`);

            const createResp = await axios.post(
              "https://www.wixapis.com/stores/v3/products",
              wixPayload,
              { headers: WIX_HEADERS }
            );

            const newWixId = createResp.data?.product?.id;
            if (newWixId) {
              console.log(`[WIX BACKGROUND] Created ${newWixId}`);
              resolvedWixProductId = newWixId;
              nameToWixId[p.productName] = newWixId;
            }
          }

          // Mark all group items as synced
          for (const gItem of p.groupItems) {
            const pid = nameToWixId[p.productName] || resolvedWixProductId;
            await Inventory.findByIdAndUpdate(gItem._id, {
              wixSynced: true,
              wixSyncedAt: new Date(),
              wixProductId: pid,
            });
          }

          syncedCount++;
        } catch (wixErr) {
          errorCount++;
          console.error(`[WIX BACKGROUND] Wix API error for "${p.productName}":`, wixErr.response?.data || wixErr.message);
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

module.exports = {
  syncWithWix,
  markInventorySynced,            // added by shiva
  exportAndSyncAllParts,          // new
  exportAndSyncByMake,            // new
  exportAndSyncByYear,            // new
  exportAndSyncByModel,           // new
  exportAndSyncDeduplicated,      // new – deduplicated by Year+Make+Model+PartName with quantity
};