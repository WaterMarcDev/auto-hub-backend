const wixService = require("../services/wix.service");

const syncWithWix = async (req, res) => {
  try {
    const wixData = await wixService.syncWithWix();
    res.status(200).json(wixData); // added by shiva
  } catch (error) {
    console.error("Error syncing with Wix:", error);
    res.status(500).json({ error: "An error occurred while syncing with Wix." });
  }
};

// Mark Inventory Synced Route by shiva
const markInventorySynced = async (req, res) => {
  try {
    console.log("PATCH BODY:", req.body);

    const inventory = await wixService.markInventorySynced(req.params.inventoryId, req.body.wixProductId);

    if (!inventory) {
      return res.status(404).json({ success: false, error: "Inventory not found" });
    }

    return res.status(200).json({ success: true, inventoryId: inventory._id });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// ── 1. Export ALL unsynced parts & mark them synced ──────────────────────────
// POST /api/wix/export/parts
// Body (optional): { productIdMap: { "<inventoryId>": "<wixProductId>", ... } }
const exportAndSyncAllParts = async (req, res) => {
  try {
    const productIdMap = req.body?.productIdMap || {};
    const { exported, parts } = await wixService.exportAndSyncAllParts(productIdMap);
    return res.status(200).json({ success: true, exported, parts });
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
    const { exported, groups } = await wixService.exportAndSyncByMake(productIdMap);
    return res.status(200).json({ success: true, exported, groups });
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
    const { exported, groups } = await wixService.exportAndSyncByYear(productIdMap);
    return res.status(200).json({ success: true, exported, groups });
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
    const { exported, groups } = await wixService.exportAndSyncByModel(productIdMap);
    return res.status(200).json({ success: true, exported, groups });
  } catch (error) {
    console.error("exportAndSyncByModel error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// ── 5. Export unsynced parts deduplicated by Brand + Part Name with quantity ─
// POST /api/wix/export/parts/deduplicated
// Responds immediately with summary; Wix API calls run in background — this
// exact response-then-background-work ordering is preserved from the
// original controller (an HTTP response-timing concern kept here).
const exportAndSyncDeduplicated = async (req, res) => {
  try {
    const result = await wixService.prepareDeduplicatedExport(req.query);

    if (result.shortCircuit) {
      return res.status(200).json(result.body);
    }

    // Send response first — background Wix sync continues after. Preserves
    // the exact response shape/timing of the original implementation.
    res.status(200).json(result.body);

    wixService.triggerBackgroundWixSync(result.syncPayloads);
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
    const collections = await wixService.listWixCollections();
    return res.status(200).json({ success: true, count: collections.length, collections });
  } catch (error) {
    console.error("Wix Stores collections error:", error.response?.data || error.message);
    return res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
};

module.exports = {
  syncWithWix,
  markInventorySynced, // added by shiva
  exportAndSyncAllParts, // new
  exportAndSyncByMake, // new
  exportAndSyncByYear, // new
  exportAndSyncByModel, // new
  exportAndSyncDeduplicated, // new – deduplicated by Year+Make+Model+PartName with quantity
  listWixCollections,
};
