const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const { auth } = require("../middleware/auth");
const {
  createWaiver,
  getWaivers,
  getWaiver,
  updateWaiver,
  deleteWaiver,
  getWaiversBySeller,
  getWaiversByBuyer,
  getWaiverStats,
} = require("../controllers/waiver.controller");

// Validation middleware for waiver creation
const validateWaiver = [
  body("customerType")
    .notEmpty()
    .withMessage("Customer type is required")
    .isIn(["seller", "buyer"])
    .withMessage("Customer type must be either 'seller' or 'buyer'"),
  body("idProofType").optional().isString(),
  body("idProofNumber").optional().isString(),
  body("idProofImage").optional().isString(),
  body("signatureImage").optional().isString(),
  body("employeeSignature").optional().isString(),
];

/**
 * @swagger
 * tags:
 *   name: Waivers
 *   description: Digital liability waiver and agreement APIs
 */

// @route   GET /api/waivers/stats
// @desc    Get waiver statistics
// @access  Private
/**
 * @swagger
 * /api/waivers/stats:
 *   get:
 *     summary: Get waiver statistics
 *     tags: [Waivers]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Waiver statistics retrieved successfully
 */
router.get("/stats", auth, getWaiverStats);

// @route   GET /api/waivers/seller/:sellerId
// @desc    Get waivers by seller
// @access  Private
/**
 * @swagger
 * /api/waivers/seller/{sellerId}:
 *   get:
 *     summary: Get waivers by seller ID
 *     tags: [Waivers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sellerId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of waivers for the seller
 */
router.get("/seller/:sellerId", auth, getWaiversBySeller);

// @route   GET /api/waivers/buyer/:buyerId
// @desc    Get waivers by buyer
// @access  Private
/**
 * @swagger
 * /api/waivers/buyer/{buyerId}:
 *   get:
 *     summary: Get waivers by buyer ID
 *     tags: [Waivers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: buyerId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of waivers for the buyer
 */
router.get("/buyer/:buyerId", auth, getWaiversByBuyer);

// @route   POST /api/waivers
// @desc    Create new waiver
// @access  Private
/**
 * @swagger
 * /api/waivers:
 *   post:
 *     summary: Create a new liability waiver
 *     tags: [Waivers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - customerType
 *             properties:
 *               customerType:
 *                 type: string
 *                 enum: [seller, buyer]
 *               sellerId:
 *                 type: string
 *               sellerData:
 *                 type: object
 *                 properties:
 *                   firstName:
 *                     type: string
 *                   lastName:
 *                     type: string
 *                   email:
 *                     type: string
 *                   mobileNo:
 *                     type: string
 *               buyerId:
 *                 type: string
 *               buyerData:
 *                 type: object
 *                 properties:
 *                   firstName:
 *                     type: string
 *                   lastName:
 *                     type: string
 *                   email:
 *                     type: string
 *                   mobileNo:
 *                     type: string
 *               idProofType:
 *                 type: string
 *                 example: Drivers License
 *               idProofNumber:
 *                 type: string
 *               idProofImage:
 *                 type: string
 *               signatureImage:
 *                 type: string
 *               employeeSignature:
 *                 type: string
 *               transactionData:
 *                 type: object
 *                 properties:
 *                   amount:
 *                     type: number
 *                   paymentMethod:
 *                     type: string
 *     responses:
 *       201:
 *         description: Waiver created successfully
 *       400:
 *         description: Validation error
 */
router.post("/", auth, validateWaiver, createWaiver);

// @route   GET /api/waivers
// @desc    Get all waivers
// @access  Private
/**
 * @swagger
 * /api/waivers:
 *   get:
 *     summary: Get all waivers with pagination and filters
 *     tags: [Waivers]
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
 *           default: 10
 *       - in: query
 *         name: customerType
 *         schema:
 *           type: string
 *           enum: [seller, buyer]
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Paginated list of waivers
 */
router.get("/", auth, getWaivers);

// @route   GET /api/waivers/:id
// @desc    Get single waiver
// @access  Private
/**
 * @swagger
 * /api/waivers/{id}:
 *   get:
 *     summary: Get a waiver by ID
 *     tags: [Waivers]
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
 *         description: Waiver details
 *       404:
 *         description: Waiver not found
 */
router.get("/:id", auth, getWaiver);

// @route   PUT /api/waivers/:id
// @desc    Update waiver
// @access  Private
/**
 * @swagger
 * /api/waivers/{id}:
 *   put:
 *     summary: Update an existing waiver
 *     tags: [Waivers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               idProofType:
 *                 type: string
 *               idProofNumber:
 *                 type: string
 *               idProofImage:
 *                 type: string
 *               signatureImage:
 *                 type: string
 *     responses:
 *       200:
 *         description: Waiver updated successfully
 */
router.put("/:id", auth, updateWaiver);

// @route   DELETE /api/waivers/:id
// @desc    Delete waiver
// @access  Private
/**
 * @swagger
 * /api/waivers/{id}:
 *   delete:
 *     summary: Soft delete a waiver
 *     tags: [Waivers]
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
 *         description: Waiver deleted successfully
 */
router.delete("/:id", auth, deleteWaiver);

module.exports = router;
