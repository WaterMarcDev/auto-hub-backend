const Tag = require("../models/Tag.model");

const formatBarcode = (number, digits) => `AUT${String(number).padStart(digits, "0")}`;

// POST /api/tags/generate — generate a batch of tags
const generateTags = async (req, res) => {
  try {
    const { count = 1, digits = 6 } = req.body;
    const batchSize = Math.min(parseInt(count), 500);

    // Find the max existing barcodeNumber
    const last = await Tag.findOne().sort({ barcodeNumber: -1 });
    let startNum = last ? last.barcodeNumber + 1 : 1;

    const tags = [];
    for (let i = 0; i < batchSize; i++) {
      const num = startNum + i;
      tags.push({ barcodeNumber: num, digits, barcodeString: formatBarcode(num, digits) });
    }

    const created = await Tag.insertMany(tags, { ordered: false });
    res.status(201).json({ message: `${created.length} tags generated`, tags: created });
  } catch (error) {
    console.error("Generate tags error:", error);
    res.status(500).json({ error: "Server error", details: error.message });
  }
};

// GET /api/tags
const getTags = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const filter = {};
    if (req.query.isUsed !== undefined) filter.isUsed = req.query.isUsed === "true";
    if (req.query.search) filter.barcodeString = { $regex: req.query.search, $options: "i" };

    const [tags, total] = await Promise.all([
      Tag.find(filter).populate("inventoryId").skip(skip).limit(limit).sort({ barcodeNumber: 1 }),
      Tag.countDocuments(filter),
    ]);
    res.json({ tags, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/tags/:id
const getTagById = async (req, res) => {
  try {
    const tag = await Tag.findById(req.params.id).populate("inventoryId");
    if (!tag) return res.status(404).json({ error: "Tag not found" });
    res.json({ tag });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// PATCH /api/tags/:id/assign — assign tag to an inventory item
const assignTag = async (req, res) => {
  try {
    const { inventoryId } = req.body;
    if (!inventoryId) return res.status(400).json({ error: "inventoryId is required" });

    // Ensure the inventory item doesn't already have a tag
    const existingTag = await Tag.findOne({ inventoryId });
    if (existingTag) return res.status(400).json({ error: "Inventory item already has a tag assigned" });

    const tag = await Tag.findByIdAndUpdate(
      req.params.id,
      { isUsed: true, inventoryId },
      { new: true }
    ).populate("inventoryId");

    if (!tag) return res.status(404).json({ error: "Tag not found" });
    res.json({ message: "Tag assigned successfully", tag });
  } catch (error) {
    res.status(500).json({ error: "Server error", details: error.message });
  }
};

// DELETE /api/tags/:id
const deleteTag = async (req, res) => {
  try {
    await Tag.findByIdAndDelete(req.params.id);
    res.json({ message: "Tag deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = { generateTags, getTags, getTagById, assignTag, deleteTag };
