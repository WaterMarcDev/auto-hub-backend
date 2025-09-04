const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const { auth } = require("../middleware/auth");
const {
  createSeller,
  getSellers,
  getSeller,
  updateSeller,
  deleteSeller,
  getSellerCarIntakes,
  searchSellers,
} = require("../controllers/sellerController");

// Validation middleware
const validateSeller = [
  body("firstName").notEmpty().withMessage("First name is required"),
  body("lastName").notEmpty().withMessage("Last name is required"),
  body("email").isEmail().withMessage("Valid email is required"),
  body("mobileNo").notEmpty().withMessage("Mobile number is required"),
];

// @route   GET /api/sellers/search
// @desc    Search sellers
// @access  Private
router.get("/search", auth, searchSellers);

// @route   POST /api/sellers
// @desc    Create new seller
// @access  Private
router.post("/", auth, validateSeller, createSeller);

// @route   GET /api/sellers
// @desc    Get all sellers
// @access  Private
router.get("/", auth, getSellers);

// @route   GET /api/sellers/:id
// @desc    Get single seller
// @access  Private
router.get("/:id", auth, getSeller);

// @route   GET /api/sellers/:id/car-intakes
// @desc    Get seller's car intakes
// @access  Private
router.get("/:id/car-intakes", auth, getSellerCarIntakes);

// @route   PUT /api/sellers/:id
// @desc    Update seller
// @access  Private
router.put("/:id", auth, validateSeller, updateSeller);

// @route   DELETE /api/sellers/:id
// @desc    Delete seller
// @access  Private
router.delete("/:id", auth, deleteSeller);

module.exports = router;
