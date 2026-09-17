const { validationResult } = require("express-validator");
const waiverService = require("../services/waiver.service");

function handleError(res, error, label, fallback) {
  console.error(`${label}:`, error);
  if (error.statusCode) {
    const body = { error: error.responseError || error.message };
    if (error.details !== undefined) body.details = error.details;
    return res.status(error.statusCode).json(body);
  }
  return res.status(500).json(fallback || { error: "Server error" });
}

// @desc    Create new waiver
// @route   POST /api/waivers
// @access  Private
const createWaiver = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: "Validation failed",
        details: errors.array(),
      });
    }

    const { waiver, seller, buyer, transaction } = await waiverService.createWaiver(req.body, req.user._id);

    res.status(201).json({
      message: "Waiver created successfully",
      waiver,
      seller,
      buyer,
      transaction,
    });
  } catch (error) {
    handleError(res, error, "Create waiver error", {
      error: "Server error during waiver creation",
      details: error.message,
    });
  }
};

// @desc    Get all waivers
// @route   GET /api/waivers
// @access  Private
const getWaivers = async (req, res) => {
  try {
    const result = await waiverService.getWaivers(req.query);
    res.json(result);
  } catch (error) {
    handleError(res, error, "Get waivers error");
  }
};

// @desc    Get single waiver
// @route   GET /api/waivers/:id
// @access  Private
const getWaiver = async (req, res) => {
  try {
    const waiver = await waiverService.getWaiver(req.params.id);
    res.json({ waiver });
  } catch (error) {
    handleError(res, error, "Get waiver error");
  }
};

// @desc    Update waiver
// @route   PUT /api/waivers/:id
// @access  Private
const updateWaiver = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: "Validation failed",
        details: errors.array(),
      });
    }

    const updatedWaiver = await waiverService.updateWaiver(req.params.id, req.body, req.user._id);

    res.json({
      message: "Waiver updated successfully",
      waiver: updatedWaiver,
    });
  } catch (error) {
    handleError(res, error, "Update waiver error", {
      error: "Server error during update",
      details: error.message,
    });
  }
};

// @desc    Delete waiver
// @route   DELETE /api/waivers/:id
// @access  Private
const deleteWaiver = async (req, res) => {
  try {
    await waiverService.deleteWaiver(req.params.id);
    res.json({ message: "Waiver soft-deleted successfully" });
  } catch (error) {
    handleError(res, error, "Delete waiver error");
  }
};

// @desc    Get waivers by seller
// @route   GET /api/waivers/seller/:sellerId
// @access  Private
const getWaiversBySeller = async (req, res) => {
  try {
    const result = await waiverService.getWaiversBySeller(req.params.sellerId);
    res.json(result);
  } catch (error) {
    handleError(res, error, "Get seller waivers error");
  }
};

// @desc    Get waivers by buyer
// @route   GET /api/waivers/buyer/:buyerId
// @access  Private
const getWaiversByBuyer = async (req, res) => {
  try {
    const result = await waiverService.getWaiversByBuyer(req.params.buyerId);
    res.json(result);
  } catch (error) {
    handleError(res, error, "Get buyer waivers error");
  }
};

// @desc    Get waiver statistics
// @route   GET /api/waivers/stats
// @access  Private
const getWaiverStats = async (req, res) => {
  try {
    const result = await waiverService.getWaiverStats(req.query);
    res.json(result);
  } catch (error) {
    handleError(res, error, "Get waiver stats error");
  }
};

module.exports = {
  createWaiver,
  getWaivers,
  getWaiver,
  updateWaiver,
  deleteWaiver,
  getWaiversBySeller,
  getWaiversByBuyer,
  getWaiverStats,
};
