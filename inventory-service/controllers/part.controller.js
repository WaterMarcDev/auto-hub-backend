const Part = require("../models/Part.model");

// POST /api/part
const createPart = async (req, res) => {
  try {
    const { name, shortName, category, unit, weight, dimensions, image, description } = req.body;
    const existing = await Part.findOne({ name: new RegExp(`^${name}$`, "i"), isDeleted: false });
    if (existing) return res.status(400).json({ error: "Part with this name already exists" });
    const part = await Part.create({ name, shortName, category, unit, weight, dimensions, image, description });
    res.status(201).json({ message: "Part created successfully", part });
  } catch (error) {
    res.status(500).json({ error: "Server error", details: error.message });
  }
};

// GET /api/part
const getParts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const filter = { isDeleted: { $ne: true } };
    if (req.query.search) filter.name = { $regex: req.query.search, $options: "i" };
    if (req.query.category) filter.category = req.query.category;
    const [parts, total] = await Promise.all([
      Part.find(filter).skip(skip).limit(limit).sort({ name: 1 }),
      Part.countDocuments(filter),
    ]);
    res.json({ parts, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/part/:id
const getPartById = async (req, res) => {
  try {
    const part = await Part.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    if (!part) return res.status(404).json({ error: "Part not found" });
    res.json({ part });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// PUT /api/part/:id
const updatePart = async (req, res) => {
  try {
    const part = await Part.findOneAndUpdate(
      { _id: req.params.id, isDeleted: { $ne: true } },
      req.body, { new: true }
    );
    if (!part) return res.status(404).json({ error: "Part not found" });
    res.json({ message: "Part updated successfully", part });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// DELETE /api/part/:id
const deletePart = async (req, res) => {
  try {
    const part = await Part.findOneAndUpdate(
      { _id: req.params.id, isDeleted: { $ne: true } },
      { isDeleted: true, deleted: true, deletedAt: new Date() }, { new: true }
    );
    if (!part) return res.status(404).json({ error: "Part not found" });
    res.json({ message: "Part deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = { createPart, getParts, getPartById, updatePart, deletePart };
