const Seller = require("../models/Seller");
const { validationResult } = require("express-validator");

// @desc    Create new seller
// @route   POST /api/sellers
// @access  Private
const createSeller = async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: "Validation failed",
        details: errors.array(),
      });
    }

    // Check if seller already exists with same email or mobile
    const existingSeller = await Seller.findOne({
      $or: [{ email: req.body.email }, { mobileNo: req.body.mobileNo }],
      isActive: true,
    });

    if (existingSeller) {
      return res.status(400).json({
        error: "Seller already exists with this email or mobile number",
      });
    }

    const seller = new Seller({
      ...req.body,
      createdBy: req.user._id,
    });

    await seller.save();

    res.status(201).json({
      message: "Seller created successfully",
      seller,
    });
  } catch (error) {
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
    const skip = (page - 1) * limit;

    // Build filter object
    const filter = { isActive: true };
    if (req.query.search) {
      const searchRegex = new RegExp(req.query.search, "i");
      filter.$or = [
        { firstName: searchRegex },
        { lastName: searchRegex },
        { email: searchRegex },
        { mobileNo: searchRegex },
      ];
    }

    const sellers = await Seller.find(filter)
      .populate("createdBy", "first_name last_name email")
      .populate("updatedBy", "first_name last_name email")
      .populate({
        path: "carIntakes",
        options: { sort: { createdAt: -1 } },
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Seller.countDocuments(filter);

    res.json({
      sellers,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
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
    const seller = await Seller.findById(req.params.id)
      .populate("createdBy", "first_name last_name email")
      .populate("updatedBy", "first_name last_name email")
      .populate({
        path: "carIntakes",
        select: "vin carDetails price.finalPrice status createdAt",
        options: { sort: { createdAt: -1 } },
      });

    if (!seller || !seller.isActive) {
      return res.status(404).json({ error: "Seller not found" });
    }

    res.json({ seller });
  } catch (error) {
    console.error("Get seller error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Update seller
// @route   PUT /api/sellers/:id
// @access  Private
const updateSeller = async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: "Validation failed",
        details: errors.array(),
      });
    }

    const seller = await Seller.findById(req.params.id);
    if (!seller || !seller.isActive) {
      return res.status(404).json({ error: "Seller not found" });
    }

    // Check if email or mobile is being changed and already exists
    if (req.body.email && req.body.email !== seller.email) {
      const existingEmail = await Seller.findOne({
        email: req.body.email,
        _id: { $ne: seller._id },
        isActive: true,
      });
      if (existingEmail) {
        return res.status(400).json({ error: "Email already exists" });
      }
    }

    if (req.body.mobileNo && req.body.mobileNo !== seller.mobileNo) {
      const existingMobile = await Seller.findOne({
        mobileNo: req.body.mobileNo,
        _id: { $ne: seller._id },
        isActive: true,
      });
      if (existingMobile) {
        return res.status(400).json({ error: "Mobile number already exists" });
      }
    }

    // Update seller
    Object.assign(seller, req.body, { updatedBy: req.user._id });
    await seller.save();

    const updatedSeller = await Seller.findById(seller._id)
      .populate("createdBy", "first_name last_name email")
      .populate("updatedBy", "first_name last_name email");

    res.json({
      message: "Seller updated successfully",
      seller: updatedSeller,
    });
  } catch (error) {
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
    const seller = await Seller.findById(req.params.id);
    if (!seller || !seller.isActive) {
      return res.status(404).json({ error: "Seller not found" });
    }

    // Check if seller has any car intakes
    const CarIntake = require("../models/CarIntake");
    const hasCarIntakes = await CarIntake.findOne({
      seller: seller._id,
      isActive: true,
    });

    if (hasCarIntakes) {
      return res.status(400).json({
        error: "Cannot delete seller with existing car intakes",
      });
    }

    // Soft delete - set isActive to false and mark deleted
    seller.isActive = false;
    seller.isDeleted = true;
    seller.deletedAt = new Date();
    seller.updatedBy = req.user._id;
    await seller.save();

    res.json({ message: "Seller deleted successfully" });
  } catch (error) {
    console.error("Delete seller error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Get seller's car intakes
// @route   GET /api/sellers/:id/car-intakes
// @access  Private
const getSellerCarIntakes = async (req, res) => {
  try {
    const CarIntake = require("../models/CarIntake");

    const seller = await Seller.findById(req.params.id);
    if (!seller || !seller.isActive) {
      return res.status(404).json({ error: "Seller not found" });
    }

    const carIntakes = await CarIntake.find({
      seller: seller._id,
      isActive: true,
    })
      .populate("createdBy", "first_name last_name email")
      .sort({ createdAt: -1 });

    res.json({
      seller: {
        id: seller._id,
        fullName: seller.fullName,
        email: seller.email,
        mobileNo: seller.mobileNo,
      },
      carIntakes,
    });
  } catch (error) {
    console.error("Get seller car intakes error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Search sellers
// @route   GET /api/sellers/search
// @access  Private
const searchSellers = async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.length < 2) {
      return res
        .status(400)
        .json({ error: "Search query must be at least 2 characters" });
    }

    const searchRegex = new RegExp(q, "i");
    const sellers = await Seller.find({
      isActive: true,
      $or: [
        { firstName: searchRegex },
        { lastName: searchRegex },
        { email: searchRegex },
        { mobileNo: searchRegex },
      ],
    })
      .select("firstName lastName email mobileNo")
      .limit(10);

    res.json({ sellers });
  } catch (error) {
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
