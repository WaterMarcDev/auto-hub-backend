/**
 * eBay Catalog Sync Routes
 *
 * Admin-protected endpoints for manual synchronization,
 * dry run, retry, and status monitoring.
 */
const express = require("express");
const router = express.Router();
const { auth, requireAdmin } = require("../middleware/auth");
const controller = require("../controllers/ebayCatalogSync.controller");

// POST /api/ebay/catalog-sync/run  — Run full catalog sync (admin only)
// Supports ?dryRun=true and ?max=N query params
router.post("/catalog-sync/run", auth, requireAdmin, controller.runFullSync);

// POST /api/ebay/catalog-sync/run/:id  — Sync a single product by Inventory ID (admin only)
router.post("/catalog-sync/run/:id", auth, requireAdmin, controller.runSingleSync);

// POST /api/ebay/catalog-sync/retry-failed  — Retry previously failed products (admin only)
router.post("/catalog-sync/retry-failed", auth, requireAdmin, controller.retryFailed);

// GET /api/ebay/catalog-sync/status  — Get sync status (authenticated users)
router.get("/catalog-sync/status", auth, controller.getSyncStatus);

// GET /api/ebay/catalog-sync/products  — Paginated products with eBay IDs + sync status (authenticated users)
// Supports ?page, ?pageSize (max 100), ?status, ?search
router.get("/catalog-sync/products", auth, controller.getSyncedProducts);

module.exports = router;