// by shiva
/**
 * @swagger
 * tags:
 *   name: Inventory
 *   description: Inventory Management APIs
 */
// end here


const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const { automationBotAuth } = require("../middleware/automationBotAuth"); // added by shiva
const {
  createInventory,
  bulkCreateInventory,
  getInventoryByVIN,
  updateInventoryPrice,
  getPartsMasterList,
  getAllInventories,
  searchByMakeModelYear,
  exportInventories,
  deduplicateInventory,
} = require("../controllers/inventory.controller");

// by shiva
/**
 * @swagger
 * /api/inventory:
 *   post:
 *     summary: Create inventory item
 *     tags: [Inventory]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Inventory created successfully
 */
//end here
router.post("/", auth, createInventory);

/**
 * @swagger
 * /api/inventory/bulk:
 *   post:
 *     summary: Add several parts of one car to inventory in a single request
 *     description: >
 *       Used by the Add To Inventory page instead of one request per part.
 *       Only the parts sent are created; parts already in inventory for the VIN are skipped,
 *       and each part succeeds or fails on its own. When carIntakeId is given and every
 *       selected part of that car is now in inventory, the car moves to part-added-to-inventory.
 *     tags: [Inventory]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [vin, parts]
 *             properties:
 *               carIntakeId: { type: string }
 *               vin: { type: string }
 *               make: { type: string }
 *               model: { type: string }
 *               trim: { type: string }
 *               year: { type: number }
 *               color: { type: string }
 *               parts:
 *                 type: array
 *                 maxItems: 200
 *                 items:
 *                   type: object
 *                   required: [partName]
 *                   properties:
 *                     partName: { type: string }
 *                     unit: { type: number }
 *                     cleaned: { type: boolean }
 *                     quality: { type: string }
 *                     location: { type: string }
 *                     weight: { type: string }
 *                     dimensions: { type: string }
 *                     image: { type: string, nullable: true }
 *                     assetTagId: { type: string, nullable: true, description: Asset tag barcode to attach }
 *     responses:
 *       200:
 *         description: "Batch processed: counts of created / skipped / failed, per-part results, carIntakeStatus, stillMissing"
 *       400:
 *         description: Missing VIN or parts, too many parts, invalid car intake id, or VIN mismatch
 *       401:
 *         description: Missing or invalid token
 *       404:
 *         description: Car intake not found
 */
router.post("/bulk", auth, bulkCreateInventory);

// by shiva
/**
 * @swagger
 * /api/inventory/export:
 *   get:
 *     summary: Export inventory data
 *     tags: [Inventory]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Inventory exported successfully
 */
//end here
router.get("/export", auth, exportInventories); // Specific routes before generic /:id or / (if any conflict)

// by shiva
/**
 * @swagger
 * /api/inventory/vin/{vin}:
 *   get:
 *     summary: Get inventory by VIN
 *     tags: [Inventory]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: vin
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Inventory fetched successfully
 */
//end here
router.get("/vin/:vin", auth, getInventoryByVIN);

// by shiva
/**
 * @swagger
 * /api/inventory/{id}/price:
 *   patch:
 *     summary: Update the manual selling price of a single inventory item
 *     tags: [Inventory]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               price:
 *                 type: number
 *     responses:
 *       200:
 *         description: Price updated successfully
 */
//end here
router.patch("/:id/price", auth, updateInventoryPrice);

// by shiva
/**
 * @swagger
 * /api/inventory/parts:
 *   get:
 *     summary: Get parts master list
 *     tags: [Inventory]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Parts list fetched successfully
 */
//end here
router.get("/parts", auth, getPartsMasterList);

/**
 * @swagger
 * /api/inventory/search:
 *   get:
 *     summary: Search inventory by Make + Model + Year simultaneously
 *     tags: [Inventory]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: make
 *         schema:
 *           type: string
 *         description: Make ObjectId or name
 *       - in: query
 *         name: model
 *         schema:
 *           type: string
 *         description: Model ObjectId or name
 *       - in: query
 *         name: year
 *         schema:
 *           type: number
 *       - in: query
 *         name: partName
 *         schema:
 *           type: string
 *         description: Part name to search (case-insensitive)
 *     responses:
 *       200:
 *         description: Matching inventory fetched successfully
 */
router.get("/search", auth, searchByMakeModelYear); // Specific route, kept above the generic / below

router.get("/search/automation-bot", automationBotAuth, searchByMakeModelYear); // added by shiva

// by shiva
/**
 * @swagger
 * /api/inventory:
 *   get:
 *     summary: Get all inventory items
 *     tags: [Inventory]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Inventory list fetched successfully
 */
//end here
router.get("/", auth, getAllInventories);

// POST /api/inventory/deduplicate — removes duplicate inventory records
router.post("/deduplicate", auth, deduplicateInventory);

module.exports = router;
