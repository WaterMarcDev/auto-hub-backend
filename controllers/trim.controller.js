const mongoose = require("mongoose");
const Trim = require("../models/Trim.model");
const Make = require("../models/Make.model");
const CarModel = require("../models/CarModel.model");

// Field limits (mirrored on the Add / Edit Car Trim form, TrimForm.jsx), the
// same as Car Make / Car Model. Short name is required like on Make / Model.
const MAX_TRIM_NAME_LENGTH = 50;
const MAX_TRIM_SHORT_NAME_LENGTH = 10;
const MAX_TRIM_DESCRIPTION_LENGTH = 500;

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Trimmed, inner runs of spaces collapsed.
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

const descriptionError = (value) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return "Description must be text.";
  if (value.trim().length > MAX_TRIM_DESCRIPTION_LENGTH) {
    return `Description can be at most ${MAX_TRIM_DESCRIPTION_LENGTH} characters.`;
  }
  return null;
};

const refId = (v) => (v && typeof v === "object" ? v._id : v);

// The id of a valid, not deleted make, or an error message.
const checkMake = async (make) => {
  const id = refId(make);
  if (!id) return { error: "Please select a car make." };
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    return { error: "Please select a valid car make." };
  }
  const doc = await Make.findOne({ _id: id, isDeleted: { $ne: true } }).select("_id");
  if (!doc) return { error: "The selected car make was not found." };
  return { id: doc._id };
};

// The id of a valid, not deleted model of `makeId`, or an error message.
const checkModel = async (model, makeId) => {
  const id = refId(model);
  if (!id) return { error: "Please select a car model." };
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    return { error: "Please select a valid car model." };
  }
  const doc = await CarModel.findOne({ _id: id, isDeleted: { $ne: true } }).select("_id make");
  if (!doc) return { error: "The selected car model was not found." };
  if (String(doc.make) !== String(makeId)) {
    return { error: "The selected car model does not belong to the selected car make." };
  }
  return { id: doc._id };
};

// Another (not deleted) trim of the same make + model with the same name,
// ignoring case and extra spaces ("sport" / " SPORT " / "Sport").
const findDuplicateTrim = (name, makeId, modelId, excludeId) => {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const filter = {
    make: makeId,
    model: modelId,
    name: {
      $regex: `^\\s*${words.map(escapeRegex).join("\\s+")}\\s*$`,
      $options: "i",
    },
    isDeleted: { $ne: true },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return Trim.findOne(filter);
};

const DUPLICATE_MESSAGE =
  "Trim with this name already exists for the specified make and model";

// Maps save errors to a readable 400 message; null if not a known case.
const saveErrorMessage = (error) => {
  if (error && error.name === "ValidationError" && error.errors) {
    return Object.values(error.errors)
      .map((e) => e.message)
      .join(" ");
  }
  if (error && error.name === "CastError") return "Invalid value for " + error.path;
  if (error && error.code === 11000) return DUPLICATE_MESSAGE;
  return null;
};

// @desc    Create a new trim
// @route   POST /api/trims
const createTrim = async (req, res) => {
  try {
    const { name, shortName, description } = req.body;

    const makeCheck = await checkMake(req.body.make);
    if (makeCheck.error) {
      return res.status(400).json({ message: makeCheck.error });
    }
    const modelCheck = await checkModel(req.body.model, makeCheck.id);
    if (modelCheck.error) {
      return res.status(400).json({ message: modelCheck.error });
    }
    const invalid =
      requiredTextError(name, "Trim name", MAX_TRIM_NAME_LENGTH) ||
      requiredTextError(shortName, "Short name", MAX_TRIM_SHORT_NAME_LENGTH) ||
      descriptionError(description);
    if (invalid) {
      return res.status(400).json({ message: invalid });
    }
    const make = makeCheck.id;
    const model = modelCheck.id;

    // Same trim name under the same make + model (case-insensitive).
    if (await findDuplicateTrim(name, make, model)) {
      return res.status(400).json({ message: DUPLICATE_MESSAGE });
    }

    const trim = await Trim.create({
      name: clean(name),
      make,
      model,
      shortName: clean(shortName),
      description: typeof description === "string" ? description.trim() : description,
    });

    res.status(201).json({
      message: "Trim created successfully",
      data: trim,
    });
  } catch (error) {
    console.error("Error creating trim:", error);
    const known = saveErrorMessage(error);
    if (known) return res.status(400).json({ message: known });
    res.status(500).json({
      message: "Server error while creating trim",
    });
  }
};

// @desc    Get all trims
// @route   GET /api/trims
const getAllTrims = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Build filter object
    const filter = {};

    // Exclude soft-deleted trims
    filter.isDeleted = { $ne: true };

    // Trimmed and regex-escaped: " sport" finds "Sport" and "(" no longer errors.
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (search) {
      filter.name = {
        $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $options: "i",
      };
    }

    if (req.query.make) {
      filter.make = req.query.make;
    }

    if (req.query.model) {
      filter.model = req.query.model;
    }

    const total = await Trim.countDocuments(filter);
    const trims = await Trim.find(filter)
      .populate("make")
      .populate("model")
      .skip(skip)
      .limit(limit)
      .sort({ name: 1 });

    res.status(200).json({
      trims,
      pagination: {
        page,
        limit,
        total,
      },
    });
  } catch (error) {
    console.error("Error fetching trims:", error);
    res.status(500).json({
      message: "Server error while fetching trims",
    });
  }
};

// desc   Get trim by ID
// route  GET /api/trims/:id
// access Private/Admin
const getTrimById = async (req, res) => {
  try {
    const trim = await Trim.findOne({
      _id: req.params.id,
      isDeleted: { $ne: true },
    })
      .populate("make")
      .populate("model");
    if (!trim) {
      return res.status(404).json({ message: "Trim not found" });
    }
    res.status(200).json(trim);
  } catch (error) {
    console.error("Error fetching trim by ID:", error);
    res.status(500).json({
      message: "Server error while fetching trim",
    });
  }
};

// @desc    Update a trim
// @route   PUT /api/trims/:id
// @access  Private/Admin

const updateTrim = async (req, res) => {
  try {
    const { name, shortName, description } = req.body;

    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(400).json({ message: "Invalid trim ID" });
    }

    const existing = await Trim.findOne({
      _id: req.params.id,
      isDeleted: { $ne: true },
    });
    if (!existing) {
      return res.status(404).json({ message: "Trim not found" });
    }

    // Omitted fields stay unchanged; sent fields must be valid.
    let makeId = existing.make;
    let modelId = existing.model;
    const sentMake = refId(req.body.make);
    const sentModel = refId(req.body.model);
    if (sentMake !== undefined) {
      const makeCheck = await checkMake(req.body.make);
      if (makeCheck.error) {
        return res.status(400).json({ message: makeCheck.error });
      }
      makeId = makeCheck.id;
    }
    if (sentModel !== undefined || String(makeId) !== String(existing.make)) {
      const modelCheck = await checkModel(
        sentModel !== undefined ? req.body.model : existing.model,
        makeId
      );
      if (modelCheck.error) {
        return res.status(400).json({ message: modelCheck.error });
      }
      modelId = modelCheck.id;
    }

    const invalid =
      (name !== undefined &&
        requiredTextError(name, "Trim name", MAX_TRIM_NAME_LENGTH)) ||
      (shortName !== undefined &&
        requiredTextError(shortName, "Short name", MAX_TRIM_SHORT_NAME_LENGTH)) ||
      descriptionError(description);
    if (invalid) {
      return res.status(400).json({ message: invalid });
    }

    const parentChanged =
      String(makeId) !== String(existing.make) ||
      String(modelId) !== String(existing.model);
    const nextName = name !== undefined ? name : existing.name;
    const nameChanged =
      String(clean(nextName) || "").toLowerCase() !==
      String(clean(existing.name) || "").toLowerCase();

    // Duplicate check only when the name (or make/model) actually changes,
    // so editing the description of an older trim still works.
    if ((parentChanged || nameChanged) &&
        (await findDuplicateTrim(nextName, makeId, modelId, existing._id))) {
      return res.status(400).json({ message: DUPLICATE_MESSAGE });
    }

    // Only the editable fields (the old code applied them unvalidated).
    existing.make = makeId;
    existing.model = modelId;
    if (name !== undefined) existing.name = clean(name);
    if (shortName !== undefined) existing.shortName = clean(shortName);
    if (description !== undefined) {
      existing.description = typeof description === "string" ? description.trim() : "";
    }
    await existing.save();
    const trim = await existing.populate(["make", "model"]);

    res.status(200).json({
      message: "Trim updated successfully",
      data: trim,
    });
  } catch (error) {
    console.error("Error updating trim:", error);
    const known = saveErrorMessage(error);
    if (known) return res.status(400).json({ message: known });
    res.status(500).json({
      message: "Server error while updating trim",
    });
  }
};

const deleteTrim = async (req, res) => {
  try {
    const trim = await Trim.findById(req.params.id);
    if (!trim || trim.isDeleted) {
      return res.status(404).json({ message: "Trim not found" });
    }

    trim.isDeleted = true;
    trim.deletedAt = new Date();
    await trim.save();

    res.status(200).json({ message: "Trim deleted successfully" });
  } catch (error) {
    console.error("Error deleting trim:", error);
    res.status(500).json({
      message: "Server error while deleting trim",
    });
  }
};

module.exports = {
  createTrim,
  getAllTrims,
  getTrimById,
  updateTrim,
  deleteTrim,
};
