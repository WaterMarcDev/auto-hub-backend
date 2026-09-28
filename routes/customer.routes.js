const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const {
  createCustomer,
  getAllCustomers,
  getCustomerById,
  updateCustomerById,
  deleteCustomerById,
} = require("../controllers/customer.controller");

/**
 * @swagger
 * tags:
 *   name: Customers
 *   description: Customer management and profile APIs
 */

// @route   POST /api/customers
// @desc    Create a new customer
// @access  Private
/**
 * @swagger
 * /api/customers:
 *   post:
 *     summary: Create a new customer
 *     tags: [Customers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - firstName
 *             properties:
 *               firstName:
 *                 type: string
 *               lastName:
 *                 type: string
 *               mobileNo:
 *                 type: string
 *                 example: (555)000-1234
 *               email:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [seller, buyer]
 *               idProofType:
 *                 type: string
 *               idProofNumber:
 *                 type: string
 *               idProofImage:
 *                 type: string
 *               signatureImage:
 *                 type: string
 *     responses:
 *       201:
 *         description: Customer created successfully
 *       400:
 *         description: Validation error
 */
router.post("/", auth, createCustomer);

// @route   GET /api/customers
// @desc    Get all customers with pagination, search, and type filter
// @access  Private
/**
 * @swagger
 * /api/customers:
 *   get:
 *     summary: Get all customers
 *     tags: [Customers]
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
 *         name: type
 *         schema:
 *           type: string
 *           enum: [seller, buyer]
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Paginated customer list
 */
router.get("/", auth, getAllCustomers);

// @route   GET /api/customers/:id
// @desc    Get customer by ID
// @access  Private
/**
 * @swagger
 * /api/customers/{id}:
 *   get:
 *     summary: Get customer by ID
 *     tags: [Customers]
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
 *         description: Customer details
 *       404:
 *         description: Customer not found
 */
router.get("/:id", auth, getCustomerById);

// @route   PUT /api/customers/:id
// @desc    Update customer by ID
// @access  Private
/**
 * @swagger
 * /api/customers/{id}:
 *   put:
 *     summary: Update customer details
 *     tags: [Customers]
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
 *               firstName:
 *                 type: string
 *               lastName:
 *                 type: string
 *               mobileNo:
 *                 type: string
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: Customer updated successfully
 */
router.put("/:id", auth, updateCustomerById);

// @route   DELETE /api/customers/:id
// @desc    Soft delete customer
// @access  Private
/**
 * @swagger
 * /api/customers/{id}:
 *   delete:
 *     summary: Soft delete customer
 *     tags: [Customers]
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
 *         description: Customer deleted successfully
 */
router.delete("/:id", auth, deleteCustomerById);

module.exports = router;
