const PartRequest = require("../models/PartRequest.model");

// POST /api/part-request  — public (website form)
const createPartRequest = async (req, res) => {
  try {
    const partRequest = await PartRequest.create({ ...req.body, source: req.body.source || "Online" });
    res.status(201).json({ message: "Part request submitted successfully", data: partRequest });
  } catch (error) {
    res.status(500).json({ error: "Server error", details: error.message });
  }
};

// GET /api/part-request
const getPartRequests = async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip  = (page - 1) * limit;
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.search) {
      const re = new RegExp(req.query.search, "i");
      filter.$or = [{ name: re }, { email: re }, { phone: re }, { make: re }, { model: re }, { partName: re }];
    }
    const [requests, total] = await Promise.all([
      PartRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      PartRequest.countDocuments(filter),
    ]);
    res.json({ requests, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/part-request/:id
const getPartRequestById = async (req, res) => {
  try {
    const request = await PartRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: "Part request not found" });
    res.json({ data: request });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// PUT /api/part-request/:id
const updatePartRequest = async (req, res) => {
  try {
    const request = await PartRequest.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!request) return res.status(404).json({ error: "Part request not found" });
    res.json({ message: "Part request updated", data: request });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// DELETE /api/part-request/:id
const deletePartRequest = async (req, res) => {
  try {
    await PartRequest.findByIdAndDelete(req.params.id);
    res.json({ message: "Part request deleted" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = { createPartRequest, getPartRequests, getPartRequestById, updatePartRequest, deletePartRequest };
