const Trim = require("../models/Trim.model");

const createTrim = async (req, res) => {
  try {
    const trim = await Trim.create(req.body);
    res.status(201).json({ message: "Trim created successfully", trim });
  } catch (error) {
    res.status(500).json({ error: "Server error", details: error.message });
  }
};

const getTrims = async (req, res) => {
  try {
    const filter = { isDeleted: false };
    if (req.query.make) filter.make = req.query.make;
    if (req.query.model) filter.model = req.query.model;
    if (req.query.search) filter.name = { $regex: req.query.search, $options: "i" };
    const trims = await Trim.find(filter).populate("make", "name").populate("model", "name").sort({ name: 1 });
    res.json({ trims, count: trims.length });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

const getTrimById = async (req, res) => {
  try {
    const trim = await Trim.findOne({ _id: req.params.id, isDeleted: false }).populate("make model");
    if (!trim) return res.status(404).json({ error: "Trim not found" });
    res.json({ trim });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

const updateTrim = async (req, res) => {
  try {
    const trim = await Trim.findOneAndUpdate({ _id: req.params.id, isDeleted: false }, req.body, { new: true });
    if (!trim) return res.status(404).json({ error: "Trim not found" });
    res.json({ message: "Trim updated successfully", trim });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

const deleteTrim = async (req, res) => {
  try {
    const trim = await Trim.findOneAndUpdate({ _id: req.params.id, isDeleted: false }, { isDeleted: true, deletedAt: new Date() }, { new: true });
    if (!trim) return res.status(404).json({ error: "Trim not found" });
    res.json({ message: "Trim deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = { createTrim, getTrims, getTrimById, updateTrim, deleteTrim };
