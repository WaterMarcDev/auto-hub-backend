const ScrapElement = require("../models/ScrapElement.model");
const ElementHub = require("../models/ElementHub.model");
const ElementHubHistory = require("../models/ElementHubHistory.model");

// POST /api/scrap-element
const createScrapElement = async (req, res) => {
  try {
    const { elementName, unit, quality, weight, dimensions, vin } = req.body;

    const scrapEl = await ScrapElement.create({ elementName, unit, quality, weight, dimensions, vin });

    // Automatically update ElementHub total weight
    const hub = await ElementHub.findOneAndUpdate(
      { elementName },
      { $setOnInsert: { unit: "lb" }, $inc: { totalWeight: Number(weight) || 0 } },
      { new: true, upsert: true }
    );

    // Record add history
    await ElementHubHistory.create({
      elementHubId: hub._id,
      elementName,
      type: "add",
      amount: Number(weight) || 0,
      unit: "lb",
      sourceVin: vin?.toUpperCase(),
      createdBy: req.user?._id,
    });

    res.status(201).json({ message: "Scrap element created successfully", data: scrapEl, hub });
  } catch (error) {
    console.error("Create scrap element error:", error);
    res.status(500).json({ error: "Server error", details: error.message });
  }
};

// GET /api/scrap-element
const getScrapElements = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const filter = { isDeleted: { $ne: true } };
    if (req.query.vin) filter.vin = req.query.vin.toUpperCase();
    if (req.query.search) filter.elementName = { $regex: req.query.search, $options: "i" };

    const [items, total] = await Promise.all([
      ScrapElement.find(filter).skip(skip).limit(limit).sort({ createdAt: -1 }),
      ScrapElement.countDocuments(filter),
    ]);
    res.json({ data: items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/scrap-element/:id
const getScrapElementById = async (req, res) => {
  try {
    const item = await ScrapElement.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    if (!item) return res.status(404).json({ error: "Scrap element not found" });
    res.json({ data: item });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// PUT /api/scrap-element/:id
const updateScrapElement = async (req, res) => {
  try {
    const item = await ScrapElement.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!item) return res.status(404).json({ error: "Scrap element not found" });
    res.json({ message: "Scrap element updated", data: item });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// DELETE /api/scrap-element/:id
const deleteScrapElement = async (req, res) => {
  try {
    const item = await ScrapElement.findByIdAndUpdate(req.params.id, { isDeleted: true, deletedAt: new Date() }, { new: true });
    if (!item) return res.status(404).json({ error: "Scrap element not found" });
    res.json({ message: "Scrap element deleted" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = { createScrapElement, getScrapElements, getScrapElementById, updateScrapElement, deleteScrapElement };
