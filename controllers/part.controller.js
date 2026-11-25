const Part = require("../models/Part.model");
const { removedPartsNor } = require("../utils/removedParts");
const {
  TEXT_LIMITS,
  optionalText,
  parseWeight,
  isInputError,
} = require("../utils/inventoryFieldRules");

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Another (not deleted) part with the same name, ignoring case and extra
// spaces. Two parts with one name share a row in Car Intake Step 3, so
// selecting one selected both (the duplicate "Transmission" bug).
const findDuplicatePart = (name, excludeId) => {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const filter = {
    name: { $regex: `^\\s*${words.map(escapeRegex).join("\\s+")}\\s*$`, $options: "i" },
    deleted: { $ne: true },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return Part.findOne(filter);
};

// Unit must be a whole number made of digits only (no letters / symbols).
const isValidUnit = (unit) =>
  unit === undefined || unit === null || unit === "" || /^\d+$/.test(String(unit).trim());

// Weight (0 - 15,000, max 2 decimals, no units) and dimensions (trimmed,
// max 100 chars). Blank clears the value. Returns { error } or { values }.
const checkWeightAndDimensions = (weight, dimensions) => {
  const w = parseWeight(weight, "Part weight");
  if (w.error) return { error: w.error };
  const d = optionalText(dimensions, "Part dimensions", TEXT_LIMITS.dimensions);
  if (d.error) return { error: d.error };
  return {
    values: {
      weight: w.value === undefined ? null : w.value,
      dimensions: d.value === undefined ? null : d.value,
    },
  };
};

// @desc    Create a new part
// @route   POST /api/parts
const createPart = async (req, res) => {
  try {
    const { name, shortName, category, unit, weight, dimensions, image, description } =
      req.body;

    if (!isValidUnit(unit)) {
      return res.status(400).json({ message: "Unit must contain digits only" });
    }

    const checked = checkWeightAndDimensions(weight, dimensions);
    if (checked.error) return res.status(400).json({ message: checked.error });

    // Check if part with the same name already exists (and not deleted)
    const existingPart = await findDuplicatePart(name);
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
      weight: checked.values.weight,
      dimensions: checked.values.dimensions,
      image,
      description,
    });

    res.status(201).json({
      message: "Part created successfully",
      data: part,
    });
  } catch (error) {
    if (isInputError(error)) {
      return res.status(400).json({ message: `Invalid part data: ${error.message}` });
    }
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

    // Build filter object (exclude soft-deleted, and the parts removed from
    // the CRM: see utils/removedParts.js)
    const filter = { deleted: { $ne: true }, $nor: removedPartsNor("name") };
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
    const { name, shortName, category, unit, weight, dimensions, image, description } =
      req.body;

    // Only update if not deleted
    const existing = await Part.findById(req.params.id);
    if (!existing || existing.deleted) {
      return res.status(404).json({ message: "Part not found" });
    }

    if (!isValidUnit(unit)) {
      return res.status(400).json({ message: "Unit must contain digits only" });
    }

    const checked = checkWeightAndDimensions(weight, dimensions);
    if (checked.error) return res.status(400).json({ message: checked.error });

    if (name && (await findDuplicatePart(name, existing._id))) {
      return res.status(400).json({ message: "Part with this name already exists" });
    }

    const part = await Part.findByIdAndUpdate(
      req.params.id,
      {
        name,
        shortName,
        category,
        unit,
        // Omitted (undefined) keeps the stored value; blank clears it.
        weight: weight === undefined ? undefined : checked.values.weight,
        dimensions: dimensions === undefined ? undefined : checked.values.dimensions,
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
    if (isInputError(error)) {
      return res.status(400).json({ message: `Invalid part data: ${error.message}` });
    }
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
