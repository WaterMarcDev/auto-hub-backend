const express = require("express");
const { getEntryFee, updateEntryFee } = require("../controllers/entryFee.controller");
const { auth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

// All routes require authentication and admin role
router.use(auth);
router.use(requireAdmin);

// @route   GET /api/entry-fee
// @desc    Get entry fee setting
// @access  Private/Admin
router.get("/", getEntryFee);

// @route   PUT /api/entry-fee
// @desc    Update entry fee setting
// @access  Private/Admin
router.put("/", updateEntryFee);

module.exports = router;
