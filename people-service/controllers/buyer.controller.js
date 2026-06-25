const Buyer = require("../models/Buyer.model");

const createBuyer = async (req, res) => {
  try {
    if (!req.body.firstName || !req.body.lastName)
      return res.status(400).json({ message: "First and last name are required" });
    const buyer = await new Buyer({ ...req.body, createdBy: req.user._id }).save();
    res.status(201).json(buyer);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

const getBuyers = async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip  = (page - 1) * limit;
    const filter = { isActive: true, isDeleted: { $ne: true } };
    if (req.query.search) {
      const re = new RegExp(req.query.search, "i");
      filter.$or = [{ firstName: re }, { lastName: re }, { email: re }, { mobileNo: re }];
    }
    const [buyers, total] = await Promise.all([
      Buyer.find(filter).populate("createdBy", "first_name last_name email").sort({ createdAt: -1 }).skip(skip).limit(limit),
      Buyer.countDocuments(filter),
    ]);
    res.status(200).json({ buyers, pagination: { page, limit, total } });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

const getBuyerById = async (req, res) => {
  try {
    const buyer = await Buyer.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
      .populate("createdBy", "first_name last_name email");
    if (!buyer) return res.status(404).json({ message: "Buyer not found" });
    res.status(200).json(buyer);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

const updateBuyer = async (req, res) => {
  try {
    const buyer = await Buyer.findOne({ _id: req.params.id, isActive: true, isDeleted: { $ne: true } });
    if (!buyer) return res.status(404).json({ message: "Buyer not found" });
    const { firstName, lastName, mobileNo, email, description } = req.body;
    if (firstName   !== undefined) buyer.firstName   = firstName;
    if (lastName    !== undefined) buyer.lastName    = lastName;
    if (mobileNo    !== undefined) buyer.mobileNo    = mobileNo;
    if (email       !== undefined) buyer.email       = email;
    if (description !== undefined) buyer.description = description;
    buyer.updatedBy = req.user._id;
    await buyer.save();
    res.status(200).json(buyer);
  } catch (error) {
    res.status(500).json({ message: "Server error", details: error.message });
  }
};

const deleteBuyer = async (req, res) => {
  try {
    const buyer = await Buyer.findOne({ _id: req.params.id, isActive: true, isDeleted: { $ne: true } });
    if (!buyer) return res.status(404).json({ message: "Buyer not found" });
    buyer.isActive = false; buyer.isDeleted = true; buyer.deletedAt = new Date();
    buyer.updatedBy = req.user._id;
    await buyer.save();
    res.status(200).json({ message: "Buyer deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = { createBuyer, getBuyers, getBuyerById, updateBuyer, deleteBuyer };
