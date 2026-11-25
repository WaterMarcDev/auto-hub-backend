const mongoose = require("mongoose");
const CarModel = require("../models/CarModel.model");
const Make = require("../models/Make.model");

// Field limits (mirrored on the Add / Edit Car Model form, ModelForm.jsx).
// Short names are short codes used in inventory SKUs (inventory.controller.js).
const MAX_MODEL_NAME_LENGTH = 50;
const MAX_MODEL_SHORT_NAME_LENGTH = 10;
const MAX_MODEL_DESCRIPTION_LENGTH = 500;

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
  if (value.trim().length > MAX_MODEL_DESCRIPTION_LENGTH) {
    return `Description can be at most ${MAX_MODEL_DESCRIPTION_LENGTH} characters.`;
  }
  return null;
};

// The id of a valid, not deleted make, or an error message.
const checkMake = async (make) => {
  const id = make && typeof make === "object" ? make._id : make;
  if (!id) return { error: "Please select a car make." };
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    return { error: "Please select a valid car make." };
  }
  const doc = await Make.findOne({ _id: id, isDeleted: { $ne: true } }).select("_id");
  if (!doc) return { error: "The selected car make was not found." };
  return { id: doc._id };
};

// Another (not deleted) model of the same make whose `field` equals `value`,
// ignoring case and extra spaces ("camry" / " CAMRY " / "Camry").
const findDuplicateModel = (field, value, makeId, excludeId) => {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const filter = {
    make: makeId,
    [field]: {
      $regex: `^\\s*${words.map(escapeRegex).join("\\s+")}\\s*$`,
      $options: "i",
    },
    isDeleted: { $ne: true },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return CarModel.findOne(filter);
};

// Maps save errors to a readable 400 message; null if not a known case.
const saveErrorMessage = (error) => {
  if (error && error.name === "ValidationError" && error.errors) {
    return Object.values(error.errors)
      .map((e) => e.message)
      .join(" ");
  }
  if (error && error.name === "CastError") return "Invalid value for " + error.path;
  if (error && error.code === 11000) return "This model already exists.";
  return null;
};

// @desc    Create a new model
// @route   POST /api/models
// @access  Private/Admin
const createModel = async (req, res) => {
  try {
    const { name, shortName, description } = req.body;

    const invalid =
      requiredTextError(name, "Model name", MAX_MODEL_NAME_LENGTH) ||
      requiredTextError(shortName, "Short name", MAX_MODEL_SHORT_NAME_LENGTH) ||
      descriptionError(description);
    if (invalid) {
      return res.status(400).json({ message: invalid });
    }
    const makeCheck = await checkMake(req.body.make);
    if (makeCheck.error) {
      return res.status(400).json({ message: makeCheck.error });
    }
    const make = makeCheck.id;

    // Check if model with the same name / short name already exists for
    // this make (case-insensitive, not deleted).
    if (await findDuplicateModel("name", name, make)) {
      return res.status(400).json({
        message: "Model with this name already exists for the specified make",
      });
    }
    if (await findDuplicateModel("shortName", shortName, make)) {
      return res.status(400).json({
        message: "Model with this short name already exists for the specified make",
      });
    }

    const model = await CarModel.create({
      name: clean(name),
      make,
      shortName: clean(shortName),
      description: typeof description === "string" ? description.trim() : description,
    });

    const cacheService = require("../services/cache.service");
    cacheService.delPrefix("master:model");
    req.app.get("io")?.emit("cache:invalidate", { scope: "model" });

    res.status(201).json(model);
  } catch (error) {
    console.error(error);
    const known = saveErrorMessage(error);
    if (known) return res.status(400).json({ message: known });
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Get all models
// @route   GET /api/models
// @access  Private/Admin
const getAllModels = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Build filter object
    const filter = {};

    // Exclude soft-deleted models
    filter.isDeleted = { $ne: true };

    // Trimmed and regex-escaped: " camry" finds "Camry" and "(" no longer errors.
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (search) {
      filter.name = { $regex: escapeRegex(search), $options: "i" };
    }

    if (req.query.make) {
      filter.make = req.query.make;
    }

    const total = await CarModel.countDocuments(filter);
    const models = await CarModel.find(filter)
      .populate("make")
      .skip(skip)
      .limit(limit)
      .sort({ name: 1 })
      .lean(); // Faster JSON serialization without Mongoose change tracking

    res.status(200).json({
      models,
      pagination: {
        page,
        limit,
        total,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Get model by ID
// @route   GET /api/models/:id
// @access  Private/Admin
const getModelById = async (req, res) => {
  try {
    const model = await CarModel.findOne({
      _id: req.params.id,
      isDeleted: { $ne: true },
    }).populate("make");

    if (!model) {
      return res.status(404).json({ message: "Model not found" });
    }

    res.status(200).json(model);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Update a model
// @route   PUT /api/models/:id
// @access  Private/Admin
const updateModel = async (req, res) => {
  try {
    const { name, shortName, description } = req.body;

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid model ID" });
    }

    // Omitted fields stay unchanged; sent fields must be valid.
    const invalid =
      (name !== undefined &&
        requiredTextError(name, "Model name", MAX_MODEL_NAME_LENGTH)) ||
      (shortName !== undefined &&
        requiredTextError(shortName, "Short name", MAX_MODEL_SHORT_NAME_LENGTH)) ||
      descriptionError(description);
    if (invalid) {
      return res.status(400).json({ message: invalid });
    }

    const existing = await CarModel.findOne({
      _id: req.params.id,
      isDeleted: { $ne: true },
    });
    if (!existing) {
      return res.status(404).json({ message: "Model not found" });
    }

    let makeId = existing.make;
    const sentMake =
      req.body.make && typeof req.body.make === "object" ? req.body.make._id : req.body.make;
    if (sentMake !== undefined && String(sentMake) !== String(existing.make)) {
      const makeCheck = await checkMake(req.body.make);
      if (makeCheck.error) {
        return res.status(400).json({ message: makeCheck.error });
      }
      makeId = makeCheck.id;
    }
    const makeChanged = String(makeId) !== String(existing.make);
    const same = (a, b) =>
      String(clean(a) || "").toLowerCase() === String(clean(b) || "").toLowerCase();
    const nextName = name !== undefined ? name : existing.name;
    const nextShort = shortName !== undefined ? shortName : existing.shortName;

    // Duplicate checks only when the value (or make) actually changes, so
    // editing the description of an older model still works.
    if ((makeChanged || !same(nextName, existing.name)) &&
        (await findDuplicateModel("name", nextName, makeId, existing._id))) {
      return res.status(400).json({
        message: "Model with this name already exists for the specified make",
      });
    }
    if ((makeChanged || !same(nextShort, existing.shortName)) &&
        (await findDuplicateModel("shortName", nextShort, makeId, existing._id))) {
      return res.status(400).json({
        message: "Model with this short name already exists for the specified make",
      });
    }

    // Only the editable fields (the old code applied the whole request body).
    existing.make = makeId;
    if (name !== undefined) existing.name = clean(name);
    if (shortName !== undefined) existing.shortName = clean(shortName);
    if (description !== undefined) {
      existing.description = typeof description === "string" ? description.trim() : "";
    }
    await existing.save();
    const model = await existing.populate("make");

    const cacheService = require("../services/cache.service");
    cacheService.delPrefix("master:model");
    req.app.get("io")?.emit("cache:invalidate", { scope: "model" });

    res.status(200).json(model);
  } catch (error) {
    console.error(error);
    const known = saveErrorMessage(error);
    if (known) return res.status(400).json({ message: known });
    res.status(500).json({ message: "Server error" });
  }
};

const deleteModel = async (req, res) => {
  try {
    const model = await CarModel.findById(req.params.id);
    if (!model || model.isDeleted) {
      return res.status(404).json({ message: "Model not found" });
    }

    model.isDeleted = true;
    model.deletedAt = new Date();
    await model.save();

    const cacheService = require("../services/cache.service");
    cacheService.delPrefix("master:model");
    req.app.get("io")?.emit("cache:invalidate", { scope: "model" });

    res.status(200).json({ message: "Model soft-deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  createModel,
  getAllModels,
  getModelById,
  updateModel,
  deleteModel,
};
