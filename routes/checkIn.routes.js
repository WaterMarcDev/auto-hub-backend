const express = require("express");
const router = express.Router();
const checkInController = require("../controllers/checkIn.controller");
const { auth } = require("../middleware/auth");

/**
 * @swagger
 * tags:
 *   name: CheckIns
 *   description: Front-desk customer yard check-in and checkout operations
 */

// Create check-in
/**
 * @swagger
 * /api/checkins:
 *   post:
 *     summary: Create a new customer check-in
 *     tags: [CheckIns]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - customer
 *               - type
 *               - transaction
 *             properties:
 *               customer:
 *                 type: string
 *                 description: Customer ObjectId reference
 *               type:
 *                 type: string
 *                 enum: [seller, buyer, both]
 *               numberOfPersons:
 *                 type: integer
 *                 example: 1
 *               transaction:
 *                 type: object
 *                 required:
 *                   - amount
 *                   - paymentMethod
 *                 properties:
 *                   amount:
 *                     type: number
 *                     example: 2
 *                   paymentMethod:
 *                     type: string
 *                     enum: [Cash, Bank Transfer, Zelle, Card]
 *               employeeSignature:
 *                 type: string
 *     responses:
 *       201:
 *         description: Check-in created successfully
 *       400:
 *         description: Missing required fields or validation failure
 */
router.post("/", auth, checkInController.create);

// List check-ins
/**
 * @swagger
 * /api/checkins:
 *   get:
 *     summary: Get all check-ins with pagination, search, and status filter
 *     tags: [CheckIns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [checked-in, checked-out]
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *           description: Search checkInToken, customer name, email, or mobile
 *     responses:
 *       200:
 *         description: Paginated check-in records
 */
router.get("/", auth, checkInController.getAll);

// Print invoice for check-in
/**
 * @swagger
 * /api/checkins/{id}/print-invoice:
 *   get:
 *     summary: Generate printable HTML invoice receipt for a check-in
 *     tags: [CheckIns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Rendered HTML invoice view
 *       404:
 *         description: Check-in not found
 */
router.get("/:id/print-invoice", auth, checkInController.printInvoice);

// Checkout a check-in
/**
 * @swagger
 * /api/checkins/{id}/checkout:
 *   post:
 *     summary: Check out a customer
 *     tags: [CheckIns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Customer checked out successfully
 *       400:
 *         description: Already checked out
 *       404:
 *         description: Check-in record not found
 */
router.post("/:id/checkout", auth, checkInController.checkout);

module.exports = router;
