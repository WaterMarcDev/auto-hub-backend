const Waiver = require("../models/Waiver.model");

const createWaiver = async (req, res) => {
  try {
    const waiver = await new Waiver({ ...req.body, createdBy: req.user._id }).save();
    const populated = await Waiver.findById(waiver._id)
      .populate("seller", "firstName lastName email")
      .populate("buyer", "firstName lastName email")
      .populate("createdBy", "first_name last_name email");
    res.status(201).json({ message: "Waiver created successfully", waiver: populated });
  } catch (error) {
    res.status(500).json({ error: "Server error", details: error.message });
  }
};

const getWaivers = async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip  = (page - 1) * limit;
    const filter = { isDeleted: { $ne: true } };
    if (req.query.customerType) filter.customerType = req.query.customerType;

    const [waivers, total] = await Promise.all([
      Waiver.find(filter)
        .populate("seller", "firstName lastName email mobileNo")
        .populate("buyer",  "firstName lastName email mobileNo")
        .populate("createdBy", "first_name last_name email")
        .sort({ createdAt: -1 }).skip(skip).limit(limit),
      Waiver.countDocuments(filter),
    ]);
    res.json({ waivers, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

const getWaiverById = async (req, res) => {
  try {
    const waiver = await Waiver.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
      .populate("seller buyer createdBy");
    if (!waiver) return res.status(404).json({ error: "Waiver not found" });
    res.json({ waiver });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

const updateWaiver = async (req, res) => {
  try {
    const waiver = await Waiver.findOneAndUpdate(
      { _id: req.params.id, isDeleted: { $ne: true } },
      req.body, { new: true }
    ).populate("seller buyer createdBy");
    if (!waiver) return res.status(404).json({ error: "Waiver not found" });
    res.json({ message: "Waiver updated successfully", waiver });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

const deleteWaiver = async (req, res) => {
  try {
    const waiver = await Waiver.findOneAndUpdate(
      { _id: req.params.id, isDeleted: { $ne: true } },
      { isDeleted: true, deletedAt: new Date() }, { new: true }
    );
    if (!waiver) return res.status(404).json({ error: "Waiver not found" });
    res.json({ message: "Waiver deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = { createWaiver, getWaivers, getWaiverById, updateWaiver, deleteWaiver };
