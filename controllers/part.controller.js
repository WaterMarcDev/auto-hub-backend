const Part = require("../models/Part.model");

// @desc    Create a new part
// @route   POST /api/parts
const createPart = async (req, res) => {
  try {
    const { name, shortName, unit, weight, dimensions, image, description } =
      req.body;

    // Check if part with the same name already exists (and not deleted)
    const existingPart = await Part.findOne({ name, deleted: { $ne: true } });
    if (existingPart) {
      return res.status(400).json({
        message: "Part with this name already exists",
      });
    }

    const part = await Part.create({
      name,
      shortName,
      category,
      unit,
      weight,
      dimensions,
      image,
      description,
    });

    res.status(201).json({
      message: "Part created successfully",
      data: part,
    });
  } catch (error) {
    console.error("Error creating part:", error);
    res.status(500).json({
      message: "Server error while creating part",
    });
  }
};

// @desc    Get all parts
// @route   GET /api/parts
const getAllParts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Build filter object (exclude soft-deleted)
    const filter = { deleted: { $ne: true } };
    if (req.query.search) {
      filter.name = { $regex: req.query.search, $options: "i" };
    }
    const parts = await Part.find(filter)
      .skip(skip)
      .limit(limit)
      .sort({ name: 1 });
    const total = await Part.countDocuments(filter);

    res.status(200).json({
      parts,
      pagination: {
        page,
        limit,
        total,
      },
    });
  } catch (error) {
    console.error("Error retrieving parts:", error);
    res.status(500).json({
      message: "Server error while retrieving parts",
    });
  }
};

// @desc    Get part by ID
// @route   GET /api/parts/:id
const getPartById = async (req, res) => {
  try {
    const part = await Part.findOne({
      _id: req.params.id,
      $or: [{ deleted: { $ne: true } }, { isDeleted: { $ne: true } }],
    });
    if (!part || part.deleted || part.isDeleted) {
      return res.status(404).json({ message: "Part not found" });
    }
    res.status(200).json(part);
  } catch (error) {
    console.error("Error retrieving part:", error);
    res.status(500).json({
      message: "Server error while retrieving part",
    });
  }
};

// @desc    Update part by ID
// @route   PUT /api/parts/:id
const updatePart = async (req, res) => {
  try {
    const { name, shortName, unit, weight, dimensions, image, description } =
      req.body;

    // Only update if not deleted
    const existing = await Part.findById(req.params.id);
    if (!existing || existing.deleted) {
      return res.status(404).json({ message: "Part not found" });
    }

    const part = await Part.findByIdAndUpdate(
      req.params.id,
      {
        name,
        shortName,
        unit,
        weight,
        dimensions,
        image,
        description,
      },
      { new: true }
    );

    res.status(200).json({
      message: "Part updated successfully",
      data: part,
    });
  } catch (error) {
    console.error("Error updating part:", error);
    res.status(500).json({
      message: "Server error while updating part",
    });
  }
};

// @desc    Delete part by ID
// @route   DELETE /api/parts/:id
const deletePart = async (req, res) => {
  try {
    // Soft delete: set deleted flag and timestamp
    const part = await Part.findById(req.params.id);
    if (!part || part.deleted) {
      return res.status(404).json({ message: "Part not found" });
    }

    part.deleted = true;
    part.isDeleted = true;
    part.deletedAt = new Date();
    await part.save();

    res.status(200).json({ message: "Part deleted successfully" });
  } catch (error) {
    console.error("Error deleting part:", error);
    res.status(500).json({ message: "Server error while deleting part" });
  }
};

module.exports = {
  createPart,
  getAllParts,
  getPartById,
  updatePart,
  deletePart,
};
