const Make = require("../models/Make.model");

// POST /api/make
const createMake = async (req, res) => {
  try {
    const { name, shortName, description } = req.body;
    const existing = await Make.findOne({ name, isDeleted: false });
    if (existing) return res.status(400).json({ error: "Make already exists" });
    const make = await Make.create({ name, shortName, description });
    res.status(201).json({ message: "Make created successfully", make });
  } catch (error) {
    res.status(500).json({ error: "Server error", details: error.message });
  }
};

// GET /api/make
const getMakes = async (req, res) => {
  try {
    const filter = { isDeleted: false };
    if (req.query.search) filter.name = { $regex: req.query.search, $options: "i" };
    const makes = await Make.find(filter).sort({ name: 1 });
    res.json({ makes, count: makes.length });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/make/:id
const getMakeById = async (req, res) => {
  try {
    const make = await Make.findOne({ _id: req.params.id, isDeleted: false });
    if (!make) return res.status(404).json({ error: "Make not found" });
    res.json({ make });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// PUT /api/make/:id
const updateMake = async (req, res) => {
  try {
    const make = await Make.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      req.body,
      { new: true }
    );
    if (!make) return res.status(404).json({ error: "Make not found" });
    res.json({ message: "Make updated successfully", make });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// DELETE /api/make/:id
const deleteMake = async (req, res) => {
  try {
    const make = await Make.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true }
    );
    if (!make) return res.status(404).json({ error: "Make not found" });
    res.json({ message: "Make deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = { createMake, getMakes, getMakeById, updateMake, deleteMake };
