const Inventory = require("../models/Inventory.model");

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
  await Inventory.findByIdAndUpdate(item._id, {
    wixSynced: true,
    wixSyncedAt: new Date(),
    wixProductId,
  });

  return {
    externalId: item._id.toString(),
    wixProductId,
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
    productType: "physical",
    price: 1,
    visible: false,
    slug: `${item.make.name}-${item.model.name}-${
      item.trim.name
    }-${item.partName.replace(/([A-Z])/g, "-$1").replace(/^-/, "")}-${
      item.year
    }`,
    brand: item.make.name,
    category: item.category,
    customTextFields: [
      { title: "externalId", value: item._id.toString() },
      { title: "make",       value: item.make.name },
      { title: "model",      value: item.model.name },
      { title: "trim",       value: item.trim.name },
      { title: "year",       value: item.year.toString() },
    ],
    currency: "USD",
  };
};

// ── 1. Export ALL unsynced parts & mark them synced ──────────────────────────
// POST /api/wix/export/parts
// Body (optional): { productIdMap: { "<inventoryId>": "<wixProductId>", ... } }
const exportAndSyncAllParts = async (req, res) => {
  try {
    const productIdMap = req.body?.productIdMap || {};

    const items = await Inventory.find({ wixSynced: false })
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

module.exports = {
  syncWithWix,
  markInventorySynced,         // added by shiva
  exportAndSyncAllParts,       // new
  exportAndSyncByMake,         // new
  exportAndSyncByYear,         // new
  exportAndSyncByModel,        // new
};
