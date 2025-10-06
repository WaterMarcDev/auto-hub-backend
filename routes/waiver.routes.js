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

// @route   GET /api/waivers/stats
// @desc    Get waiver statistics
// @access  Private
router.get("/stats", auth, getWaiverStats);

// @route   GET /api/waivers/seller/:sellerId
// @desc    Get waivers by seller
// @access  Private
router.get("/seller/:sellerId", auth, getWaiversBySeller);

// @route   GET /api/waivers/buyer/:buyerId
// @desc    Get waivers by buyer
// @access  Private
router.get("/buyer/:buyerId", auth, getWaiversByBuyer);

// @route   POST /api/waivers
// @desc    Create new waiver
// @access  Private
router.post("/", auth, validateWaiver, createWaiver);

// @route   GET /api/waivers
// @desc    Get all waivers
// @access  Private
router.get("/", auth, getWaivers);

// @route   GET /api/waivers/:id
// @desc    Get single waiver
// @access  Private
router.get("/:id", auth, getWaiver);

// @route   PUT /api/waivers/:id
// @desc    Update waiver
// @access  Private
router.put("/:id", auth, updateWaiver);

// @route   DELETE /api/waivers/:id
// @desc    Delete waiver
// @access  Private
router.delete("/:id", auth, deleteWaiver);

module.exports = router;
