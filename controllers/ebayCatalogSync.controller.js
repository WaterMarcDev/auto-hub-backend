/**
 * eBay Catalog Sync Controller
 *
 * API endpoints for manual/retry/dry-run/status operations on the
 * CRM → eBay catalog synchronization pipeline.
 *
 * All endpoints use the same underlying ebayCatalogSync.service.js
 * that the 6-hour scheduled job uses (via
 * services/ebayCatalogSyncController.service.js, the orchestration layer
 * introduced by the clean-architecture migration).
 */
const ebayCatalogSyncControllerService = require("../services/ebayCatalogSyncController.service");
const ebayConfig = require("../config/ebayCatalogConfig");

/**
 * POST /api/ebay/catalog-sync/run
 * Run full catalog synchronization (or dry run).
 */
exports.runFullSync = async (req, res) => {
  try {
    const dryRun = req.query.dryRun === "true";
    const maxProducts = req.query.max
      ? parseInt(req.query.max, 10) || 0
      : ebayConfig.EBAY_SYNC_MAX_PRODUCTS || 0;

    const result = await ebayCatalogSyncControllerService.runFullSync({ dryRun, maxProducts });

    res.json({
      success: true,
      dryRun,
      data: result,
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        error: err.message,
      });
    }
    console.error("[EBAY_CATALOG_SYNC] Error running full sync:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/ebay/catalog-sync/run/:id
 * Synchronize a single Inventory product by ID.
 */
exports.runSingleSync = async (req, res) => {
  try {
    const { id } = req.params;
    const dryRun = req.query.dryRun === "true";

    const result = await ebayCatalogSyncControllerService.runSingleSync(id, dryRun);

    res.json({
      success: true,
      dryRun,
      data: result,
    });
  } catch (err) {
    console.error(`[EBAY_CATALOG_SYNC] Error syncing product ${req.params.id}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/ebay/catalog-sync/retry-failed
 * Retry previously failed products.
 * Requires a list of product IDs to retry.
 */
exports.retryFailed = async (req, res) => {
  try {
    const { productIds } = req.body;
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ success: false, error: "productIds array is required" });
    }

    const result = await ebayCatalogSyncControllerService.retryFailedProducts(productIds);

    res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    console.error("[EBAY_CATALOG_SYNC] Error retrying failed products:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/ebay/catalog-sync/status
 * Get the current and last sync status.
 */
exports.getSyncStatus = async (req, res) => {
  try {
    const status = await ebayCatalogSyncControllerService.getSyncStatus();

    res.json({ success: true, data: status });
  } catch (err) {
    console.error("[EBAY_CATALOG_SYNC] Error getting status:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};
