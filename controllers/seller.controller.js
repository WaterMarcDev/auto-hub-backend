const { validationResult } = require("express-validator");
const sellerService = require("../services/seller.service");

// @desc    Create new seller
// @route   POST /api/sellers
// @access  Private
const createSeller = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: "Validation failed",
        details: errors.array(),
      });
    }

    const seller = await sellerService.createSeller({
      body: req.body,
      createdBy: req.user._id,
    });

    res.status(201).json({
      message: "Seller created successfully",
      seller,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("Create seller error:", error);
    res.status(500).json({
      error: "Server error during seller creation",
      details: error.message,
    });
  }
};

// @desc    Get all sellers
// @route   GET /api/sellers
// @access  Private
const getSellers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    const result = await sellerService.getSellers({
      page,
      limit,
      search: req.query.search,
    });

    res.json(result);
  } catch (error) {
    console.error("Get sellers error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Get single seller
// @route   GET /api/sellers/:id
// @access  Private
const getSeller = async (req, res) => {
  try {
    const seller = await sellerService.getSeller(req.params.id);
    res.json({ seller });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("Get seller error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Update seller
// @route   PUT /api/sellers/:id
// @access  Private
const updateSeller = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: "Validation failed",
        details: errors.array(),
      });
    }

    const updatedSeller = await sellerService.updateSeller(
      req.params.id,
      req.body,
      req.user._id
    );

    res.json({
      message: "Seller updated successfully",
      seller: updatedSeller,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("Update seller error:", error);
    res.status(500).json({
      error: "Server error during update",
      details: error.message,
    });
  }
};

// @desc    Delete seller
// @route   DELETE /api/sellers/:id
// @access  Private
const deleteSeller = async (req, res) => {
  try {
    await sellerService.deleteSeller(req.params.id, req.user._id);
    res.json({ message: "Seller deleted successfully" });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("Delete seller error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Get seller's car intakes
// @route   GET /api/sellers/:id/car-intakes
// @access  Private
const getSellerCarIntakes = async (req, res) => {
  try {
    const result = await sellerService.getSellerCarIntakes(req.params.id);
    res.json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("Get seller car intakes error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Search sellers
// @route   GET /api/sellers/search
// @access  Private
const searchSellers = async (req, res) => {
  try {
    const sellers = await sellerService.searchSellers(req.query.q);
    res.json({ sellers });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("Search sellers error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = {
  createSeller,
  getSellers,
  getSeller,
  updateSeller,
  deleteSeller,
  getSellerCarIntakes,
  searchSellers,
};
