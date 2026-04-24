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
const {
  createInventory,
  getInventoryByVIN,
  getPartsMasterList,
  getAllInventories,
  exportInventories,
} = require("../controllers/Inventory.controller");

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

module.exports = router;
