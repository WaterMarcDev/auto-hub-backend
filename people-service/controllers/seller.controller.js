const Seller = require("../models/Seller.model");

// POST /api/sellers
const createSeller = async (req, res) => {
  try {
    const existing = await Seller.findOne({
      $or: [{ email: req.body.email }, { mobileNo: req.body.mobileNo }],
      isActive: true, isDeleted: false,
    });
    if (existing) return res.status(400).json({ error: "Seller already exists with this email or mobile number" });

    const seller = await new Seller({ ...req.body, createdBy: req.user._id }).save();
    res.status(201).json({ message: "Seller created successfully", seller });
  } catch (error) {
    res.status(500).json({ error: "Server error", details: error.message });
  }
};

// GET /api/sellers
const getSellers = async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip  = (page - 1) * limit;
    const filter = { isActive: true, isDeleted: false };
    if (req.query.search) {
      const re = new RegExp(req.query.search, "i");
      filter.$or = [{ firstName: re }, { lastName: re }, { email: re }, { mobileNo: re }];
    }
    const [sellers, total] = await Promise.all([
      Seller.find(filter)
        .populate("createdBy", "first_name last_name email")
        .populate("updatedBy", "first_name last_name email")
        .sort({ createdAt: -1 }).skip(skip).limit(limit),
      Seller.countDocuments(filter),
    ]);
    res.json({ sellers, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/sellers/search
const searchSellers = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.status(400).json({ error: "Search query must be at least 2 characters" });
    const re = new RegExp(q, "i");
    const sellers = await Seller.find({
      isActive: true,
      $or: [{ firstName: re }, { lastName: re }, { email: re }, { mobileNo: re }],
    }).select("firstName lastName email mobileNo").limit(10);
    res.json({ sellers });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/sellers/:id
const getSeller = async (req, res) => {
  try {
    const seller = await Seller.findOne({ _id: req.params.id, isActive: true, isDeleted: false })
      .populate("createdBy", "first_name last_name email")
      .populate("updatedBy", "first_name last_name email");
    if (!seller) return res.status(404).json({ error: "Seller not found" });
    res.json({ seller });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// PUT /api/sellers/:id
const updateSeller = async (req, res) => {
  try {
    const seller = await Seller.findOne({ _id: req.params.id, isActive: true, isDeleted: false });
    if (!seller) return res.status(404).json({ error: "Seller not found" });

    if (req.body.email && req.body.email !== seller.email) {
      const dup = await Seller.findOne({ email: req.body.email, _id: { $ne: seller._id }, isActive: true });
      if (dup) return res.status(400).json({ error: "Email already exists" });
    }
    if (req.body.mobileNo && req.body.mobileNo !== seller.mobileNo) {
      const dup = await Seller.findOne({ mobileNo: req.body.mobileNo, _id: { $ne: seller._id }, isActive: true });
      if (dup) return res.status(400).json({ error: "Mobile number already exists" });
    }

    Object.assign(seller, req.body, { updatedBy: req.user._id });
    await seller.save();

    const updated = await Seller.findById(seller._id)
      .populate("createdBy", "first_name last_name email")
      .populate("updatedBy", "first_name last_name email");
    res.json({ message: "Seller updated successfully", seller: updated });
  } catch (error) {
    res.status(500).json({ error: "Server error", details: error.message });
  }
};

// DELETE /api/sellers/:id
const deleteSeller = async (req, res) => {
  try {
    const seller = await Seller.findOne({ _id: req.params.id, isActive: true, isDeleted: false });
    if (!seller) return res.status(404).json({ error: "Seller not found" });
    seller.isActive = false; seller.isDeleted = true; seller.deletedAt = new Date();
    seller.updatedBy = req.user._id;
    await seller.save();
    res.json({ message: "Seller deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = { createSeller, getSellers, getSeller, updateSeller, deleteSeller, searchSellers };
