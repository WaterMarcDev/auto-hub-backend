const CarModel = require("../models/CarModel.model");

const createModel = async (req, res) => {
  try {
    const model = await CarModel.create(req.body);
    res.status(201).json({ message: "Model created successfully", model });
  } catch (error) {
    res.status(500).json({ error: "Server error", details: error.message });
  }
};

const getModels = async (req, res) => {
  try {
    const filter = { isDeleted: false };
    if (req.query.make) filter.make = req.query.make;
    if (req.query.search) filter.name = { $regex: req.query.search, $options: "i" };
    const models = await CarModel.find(filter).populate("make", "name").sort({ name: 1 });
    res.json({ models, count: models.length });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

const getModelById = async (req, res) => {
  try {
    const model = await CarModel.findOne({ _id: req.params.id, isDeleted: false }).populate("make", "name");
    if (!model) return res.status(404).json({ error: "Model not found" });
    res.json({ model });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

const updateModel = async (req, res) => {
  try {
    const model = await CarModel.findOneAndUpdate({ _id: req.params.id, isDeleted: false }, req.body, { new: true });
    if (!model) return res.status(404).json({ error: "Model not found" });
    res.json({ message: "Model updated successfully", model });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

const deleteModel = async (req, res) => {
  try {
    const model = await CarModel.findOneAndUpdate({ _id: req.params.id, isDeleted: false }, { isDeleted: true, deletedAt: new Date() }, { new: true });
    if (!model) return res.status(404).json({ error: "Model not found" });
    res.json({ message: "Model deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = { createModel, getModels, getModelById, updateModel, deleteModel };
