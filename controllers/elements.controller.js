const mongoose = require("mongoose");
const Element = require("../models/Element.model");
const ElementHub = require("../models/ElementHub.model");
const ElementHubHistory = require("../models/ElementHubHistory.model");
const ScrapElement = require("../models/ScrapElement.model");
const { TEXT_LIMITS, optionalText, parseWeight } = require("../utils/inventoryFieldRules");

// Element Hub stock, its history and saved scrap elements reference elements
// by NAME, so a rename must move them too — merging into an existing hub of
// the new name — or stock would be split between the two names.
const renameElementEverywhere = async (oldName, newName) => {
  const oldHub = await ElementHub.findOne({ elementName: oldName });
  if (oldHub) {
    const newHub = await ElementHub.findOne({ elementName: newName });
    if (newHub) {
      await ElementHub.updateOne({ _id: newHub._id }, { $inc: { totalWeight: oldHub.totalWeight || 0 } });
      await ElementHubHistory.updateMany({ elementHubId: oldHub._id }, { $set: { elementHubId: newHub._id } });
      await ElementHub.deleteOne({ _id: oldHub._id });
    } else {
      await ElementHub.updateOne({ _id: oldHub._id }, { $set: { elementName: newName } });
    }
  }
  await ElementHubHistory.updateMany({ elementName: oldName }, { $set: { elementName: newName } });
  await ScrapElement.updateMany({ elementName: oldName }, { $set: { elementName: newName } });
};

// Field limits (mirrored on the Add / Edit Element form, ElementForm.jsx).
// Name / short name / description match Car Make / Model; weight uses the
// shared weight rule (0 - 15,000, up to 2 decimals, never negative).
const MAX_ELEMENT_NAME_LENGTH = 50;
const MAX_ELEMENT_SHORT_NAME_LENGTH = 10;
const MAX_ELEMENT_DIMENSIONS_LENGTH = TEXT_LIMITS.dimensions; // 100
const MAX_ELEMENT_DESCRIPTION_LENGTH = 500;

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clean = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : v);

const requiredTextError = (value, label, max) => {
  if (typeof value !== "string" || !value.trim()) {
    return `${label} is required and cannot be only spaces.`;
  }
  if (clean(value).length > max) {
    return `${label} can be at most ${max} characters.`;
  }
  return null;
};

// Validates the sent fields. `partial` (update): omitted fields are skipped.
// Returns { error } or { values } with cleaned values to save.
const validateElementInput = (body, partial) => {
  const values = {};
  const { name, shortName, weight, dimensions, description } = body || {};
  const has = (v) => !partial || v !== undefined;

  if (has(name)) {
    const err = requiredTextError(name, "Element name", MAX_ELEMENT_NAME_LENGTH);
    if (err) return { error: err };
    values.name = clean(name);
  }
  if (has(shortName)) {
    const err = requiredTextError(shortName, "Short name", MAX_ELEMENT_SHORT_NAME_LENGTH);
    if (err) return { error: err };
    values.shortName = clean(shortName);
  }
  if (weight !== undefined) {
    const w = parseWeight(weight, "Element weight");
    if (w.error) return { error: w.error };
    values.weight = w.value === undefined ? null : w.value;
  }
  if (dimensions !== undefined) {
    const d = optionalText(dimensions, "Dimensions", MAX_ELEMENT_DIMENSIONS_LENGTH);
    if (d.error) return { error: d.error };
    // Free text such as "10 x 20 x 5 in"; a "-" sign would mean a negative size.
    if (d.value !== undefined && d.value.includes("-")) {
      return { error: "Dimensions cannot be negative (the - sign is not allowed)." };
    }
    values.dimensions = d.value === undefined ? "" : d.value;
  }
  if (description !== undefined && description !== null) {
    if (typeof description !== "string") return { error: "Description must be text." };
    if (description.trim().length > MAX_ELEMENT_DESCRIPTION_LENGTH) {
      return { error: `Description can be at most ${MAX_ELEMENT_DESCRIPTION_LENGTH} characters.` };
    }
    values.description = description.trim();
  }
  return { values };
};

// Another (not deleted) element with the same name, ignoring case and extra
// spaces ("copper" / " COPPER " / "Copper").
const findDuplicateElement = (name, excludeId) => {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const filter = {
    name: {
      $regex: `^\\s*${words.map(escapeRegex).join("\\s+")}\\s*$`,
      $options: "i",
    },
    isDeleted: { $ne: true },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return Element.findOne(filter);
};

// Mongoose validation / cast problems are bad input (400), not server errors.
const saveErrorMessage = (error) => {
  if (error && error.name === "ValidationError" && error.errors) {
    return Object.values(error.errors)
      .map((e) => e.message)
      .join(" ");
  }
  if (error && error.name === "CastError") return "Invalid value for " + error.path;
  if (error && error.code === 11000) return "Element with this name already exists";
  return null;
};

// @desc    Create a new element
// @route   POST /api/elements
const createElement = async (req, res) => {
  try {
    const checked = validateElementInput(req.body, false);
    if (checked.error) {
      return res.status(400).json({ message: checked.error });
    }
    const values = checked.values;

    // Check if element with the same name already exists (case-insensitive)
    const existingElement = await findDuplicateElement(values.name);
    if (existingElement) {
      return res.status(400).json({
        message: `Element with this name already exists ("${existingElement.name}")`,
      });
    }

    if (values.weight === null) delete values.weight;
    if (values.dimensions === "") delete values.dimensions;
    const element = await Element.create(values);

    res.status(201).json({
      message: "Element created successfully",
      data: element,
    });
  } catch (error) {
    console.error("Error creating element:", error);
    const known = saveErrorMessage(error);
    if (known) return res.status(400).json({ message: known });
    res.status(500).json({
      message: "Server error while creating element",
    });
  }
};

// @desc    Get all elements
// @route   GET /api/elements
const getAllElements = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Build filter object
    const filter = {};

    // Exclude soft-deleted elements
    filter.isDeleted = { $ne: true };
    // Trimmed and regex-escaped: " copper" finds "Copper" and "(" no longer errors.
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (search) {
      filter.name = {
        $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $options: "i",
      };
    }
    const elements = await Element.find(filter)
      .skip(skip)
      .limit(limit)
      .sort({ name: 1 });
    const total = await Element.countDocuments(filter);

    res.status(200).json({
      elements,
      pagination: {
        page,
        limit,
        total,
      },
    });
  } catch (error) {
    console.error("Error fetching elements:", error);
    res.status(500).json({
      message: "Server error while fetching elements",
    });
  }
};

// @desc    Get element by ID
// @route   GET /api/elements/:id
const getElementById = async (req, res) => {
  try {
    const element = await Element.findOne({
      _id: req.params.id,
      isDeleted: { $ne: true },
    });
    if (!element) {
      return res.status(404).json({ message: "Element not found" });
    }
    res.status(200).json(element);
  } catch (error) {
    console.error("Error fetching element:", error);
    res.status(500).json({
      message: "Server error while fetching element",
    });
  }
};

// @desc    Update element by ID
// @route   PUT /api/elements/:id
const updateElement = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Element not found" });
    }
    const existing = await Element.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    if (!existing) {
      return res.status(404).json({ message: "Element not found" });
    }

    // Omitted fields stay unchanged; sent fields must be valid.
    const checked = validateElementInput(req.body, true);
    if (checked.error) {
      return res.status(400).json({ message: checked.error });
    }
    const values = checked.values;
    const newName = values.name !== undefined ? values.name : existing.name;

    // Renaming: refuse a name another active element already uses (any
    // letter case), then move stock/history/saved elements to the new name so
    // stock is never split.
    if (newName !== existing.name) {
      const duplicate = await findDuplicateElement(newName, existing._id);
      if (duplicate) {
        return res.status(409).json({ message: `An element named "${duplicate.name}" already exists` });
      }
      await renameElementEverywhere(existing.name, newName);
    }

    const element = await Element.findByIdAndUpdate(
      existing._id,
      { $set: { ...values, name: newName } },
      { new: true, runValidators: true }
    );

    res.status(200).json({
      message: "Element updated successfully",
      data: element,
    });
  } catch (error) {
    console.error("Error updating element:", error);
    const known = saveErrorMessage(error);
    if (known) return res.status(400).json({ message: known });
    res.status(500).json({
      message: "Server error while updating element",
    });
  }
};

const deleteElement = async (req, res) => {
  try {
    const element = await Element.findById(req.params.id);
    if (!element || element.isDeleted) {
      return res.status(404).json({ message: "Element not found" });
    }

    element.isDeleted = true;
    element.deletedAt = new Date();
    await element.save();
    res.status(200).json({ message: "Element deleted successfully" });
  } catch (error) {
    console.error("Error deleting element:", error);
    res.status(500).json({
      message: "Server error while deleting element",
    });
  }
};

module.exports = {
  createElement,
  getAllElements,
  getElementById,
  updateElement,
  deleteElement,
};
