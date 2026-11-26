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

// Field limits, mirrored on the Add / Edit Part form (pages/Part/PartForm.jsx).
// Short names go into inventory SKUs (make/model/year-PART/color, see
// inventory.controller.js), so they are short codes without "/" or spaces.
const PART_LIMITS = {
  name: 100,
  shortName: 10,
  unitDigits: 6, // 1 - 999,999
  description: 500,
};
// Letters (any language), digits, spaces and - / & ( ) . ' ,  - must start
// with a letter or digit.
const PART_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} \-/&().',]*$/u;
// Letters, digits and "-".
const SHORT_NAME_PATTERN = /^[A-Za-z0-9-]+$/;
// 1 to 3 positive numbers (max 2 decimals) separated by "x", each optionally
// followed by a unit: "12 x 8 x 4", "12.5in x 8in", "30 cm". No "-" signs.
const DIM_NUM = String.raw`\d{1,6}(?:\.\d{1,2})?(?:\s*(?:mm|cm|m|inches|inch|in|feet|ft|"|'))?`;
const DIMENSIONS_PATTERN = new RegExp(`^${DIM_NUM}(?:\\s*[x×*]\\s*${DIM_NUM}){0,2}$`, "i");

const clean = (v) => String(v).trim().replace(/\s+/g, " ");
const isBlankValue = (v) => v === undefined || v === null || String(v).trim() === "";
// Value equal to what is stored (legacy values are not re-validated on edit).
const sameAs = (value, stored) =>
  stored !== undefined && stored !== null && clean(value) === clean(stored);

// Validates the part fields. `existing` is the stored part on update: fields
// left out (undefined) are kept, and unchanged legacy values are not
// re-checked against the newer format rules. Returns { error } or { values }.
const validatePartInput = (body, existing) => {
  const isUpdate = Boolean(existing);
  const { name, shortName, unit, weight, dimensions, image, description } = body;
  const values = {};
  const provided = (v) => !isUpdate || v !== undefined;

  // Name / short name: required text.
  for (const [key, label, value, max, pattern, rule] of [
    ["name", "Part name", name, PART_LIMITS.name, PART_NAME_PATTERN,
      "letters, digits, spaces and - / & ( ) . ' ,"],
    ["shortName", "Short name", shortName, PART_LIMITS.shortName, SHORT_NAME_PATTERN,
      "letters, digits and -"],
  ]) {
    if (!provided(value)) continue;
    if (typeof value !== "string" || !value.trim()) {
      return { error: `${label} is required and cannot be only spaces` };
    }
    const text = clean(value);
    if (!(isUpdate && sameAs(text, existing[key]))) {
      if (text.length > max) return { error: `${label} can be at most ${max} characters` };
      if (!pattern.test(text)) return { error: `${label} can contain only ${rule}` };
    }
    values[key] = text;
  }

  // Unit: required whole number 1 - 999,999 (digits only).
  if (provided(unit)) {
    if (isBlankValue(unit)) return { error: "Part unit is required" };
    const text = String(unit).trim();
    if (typeof unit === "object" || !/^\d+$/.test(text)) {
      return { error: "Part unit must contain digits only" };
    }
    if (Number(text) < 1 || text.replace(/^0+/, "").length > PART_LIMITS.unitDigits) {
      return { error: "Part unit must be a whole number from 1 to 999,999" };
    }
    values.unit = String(Number(text));
  }

  // Weight: 0 - 15,000 lb, max 2 decimals. Blank clears it.
  if (provided(weight)) {
    const w = parseWeight(weight, "Part weight");
    if (w.error) return { error: w.error };
    values.weight = w.value === undefined ? null : w.value;
  }

  // Dimensions: optional, max 100 chars, "L x W x H" numbers. Blank clears it.
  if (provided(dimensions)) {
    const d = optionalText(dimensions, "Part dimensions", TEXT_LIMITS.dimensions);
    if (d.error) return { error: d.error };
    if (
      d.value !== undefined &&
      !(isUpdate && sameAs(d.value, existing.dimensions)) &&
      !DIMENSIONS_PATTERN.test(d.value)
    ) {
      return {
        error:
          'Part dimensions must be up to 3 positive numbers separated by "x" (e.g. 12 x 8 x 4 or 30 cm x 20 cm), no negative values or other text',
      };
    }
    values.dimensions = d.value === undefined ? null : d.value;
  }

  // Description: optional text, max 500 chars.
  if (provided(description)) {
    if (isBlankValue(description)) values.description = "";
    else if (typeof description !== "string") return { error: "Description must be text" };
    else {
      const text = description.trim();
      if (text.length > PART_LIMITS.description) {
        return { error: `Description can be at most ${PART_LIMITS.description} characters` };
      }
      values.description = text;
    }
  }

  // Image: uploaded file path (string) or cleared.
  if (provided(image)) {
    if (isBlankValue(image)) values.image = null;
    else if (typeof image !== "string") return { error: "Part image is invalid" };
    else values.image = image.trim();
  }

  return { values };
};

// @desc    Create a new part
// @route   POST /api/parts
const createPart = async (req, res) => {
  try {
    const { category } = req.body;

    const checked = validatePartInput(req.body || {});
    if (checked.error) return res.status(400).json({ message: checked.error });
    const v = checked.values;

    // Check if part with the same name already exists (and not deleted)
    const existingPart = await findDuplicatePart(v.name);
    if (existingPart) {
      return res.status(400).json({
        message: "Part with this name already exists",
      });
    }

    const part = await Part.create({
      name: v.name,
      shortName: v.shortName,
      category,
      unit: v.unit,
      weight: v.weight,
      dimensions: v.dimensions,
      image: v.image === null ? undefined : v.image,
      description: v.description,
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
    // Trimmed, inner spaces flexible, special characters escaped ("(" used
    // to cause a server error).
    const searchWords = String(req.query.search || "").trim().split(/\s+/).filter(Boolean).slice(0, 10);
    if (searchWords.length) {
      filter.name = { $regex: searchWords.map(escapeRegex).join("\\s+"), $options: "i" };
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
    const { category } = req.body || {};

    // Only update if not deleted
    const existing = await Part.findById(req.params.id);
    if (!existing || existing.deleted) {
      return res.status(404).json({ message: "Part not found" });
    }

    const checked = validatePartInput(req.body || {}, existing);
    if (checked.error) return res.status(400).json({ message: checked.error });
    const v = checked.values;

    if (v.name && (await findDuplicatePart(v.name, existing._id))) {
      return res.status(400).json({ message: "Part with this name already exists" });
    }

    // Omitted (undefined) fields keep the stored value; blank clears them.
    const part = await Part.findByIdAndUpdate(
      req.params.id,
      { ...v, category },
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
