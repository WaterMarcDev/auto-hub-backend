const mongoose = require("mongoose");
const Make = require("../models/Make.model");

// Field limits (mirrored on the Add / Edit Car Make form, MakeForm.jsx).
// Short names are 2-3 letter codes used in inventory SKUs (see
// generateShortName in inventory.controller.js).
const MAX_MAKE_NAME_LENGTH = 50;
const MAX_MAKE_SHORT_NAME_LENGTH = 10;
const MAX_MAKE_DESCRIPTION_LENGTH = 500;

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Trimmed, inner runs of spaces collapsed.
const clean = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : v);

// Error message for a required text field, or null when valid.
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
  if (value.trim().length > MAX_MAKE_DESCRIPTION_LENGTH) {
    return `Description can be at most ${MAX_MAKE_DESCRIPTION_LENGTH} characters.`;
  }
  return null;
};

// Another (not deleted) make whose `field` equals `value`, ignoring case and
// extra spaces ("toyota" / " TOYOTA " / "Toyota" are the same make).
const findDuplicateMake = (field, value, excludeId) => {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const filter = {
    [field]: {
      $regex: `^\\s*${words.map(escapeRegex).join("\\s+")}\\s*$`,
      $options: "i",
    },
    isDeleted: { $ne: true },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return Make.findOne(filter);
};

// Maps save errors to a 400 with a readable message; null if not a known case.
const saveErrorMessage = (error) => {
  if (error && error.code === 11000) {
    // The unique index on `name` also covers deleted makes.
    return "Make with this name already exists (it may have been deleted earlier).";
  }
  if (error && error.name === "ValidationError" && error.errors) {
    return Object.values(error.errors)
      .map((e) => e.message)
      .join(" ");
  }
  if (error && error.name === "CastError") return "Invalid make ID";
  return null;
};

// @desc    Create a new make
// @route   POST /api/makes
// @access  Private/Admin
const createMake = async (req, res) => {
  try {
    const { name, shortName, description } = req.body;

    const invalid =
      requiredTextError(name, "Make name", MAX_MAKE_NAME_LENGTH) ||
      requiredTextError(shortName, "Short name", MAX_MAKE_SHORT_NAME_LENGTH) ||
      descriptionError(description);
    if (invalid) {
      return res.status(400).json({ message: invalid });
    }

    // Check if make with the same name / short name already exists
    // (case-insensitive, not deleted).
    if (await findDuplicateMake("name", name)) {
      return res
        .status(400)
        .json({ message: "Make with this name already exists" });
    }
    if (await findDuplicateMake("shortName", shortName)) {
      return res
        .status(400)
        .json({ message: "Make with this short name already exists" });
    }

    const make = await Make.create({
      name: clean(name),
      shortName: clean(shortName),
      description: typeof description === "string" ? description.trim() : description,
    });

    const cacheService = require("../services/cache.service");
    cacheService.delPrefix("master:make");
    req.app.get("io")?.emit("cache:invalidate", { scope: "make" });

    res.status(201).json(make);
  } catch (error) {
    console.error(error);
    const known = saveErrorMessage(error);
    if (known) return res.status(400).json({ message: known });
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Get all makes
// @route   GET /api/makes
// @access  Private/Admin
const getAllMakes = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Build filter object
    const filter = {};
    // check for not deleted true
    filter.isDeleted = { $ne: true };
    // search by name
    // Trimmed and regex-escaped: " toyota" finds "Toyota" and "(" no longer errors.
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (search) {
      filter.name = { $regex: escapeRegex(search), $options: "i" };
    }

    const total = await Make.countDocuments(filter);
    const makes = await Make.find(filter)
      .skip(skip)
      .limit(limit)
      .sort({ name: 1 })
      .lean(); // Sort by name ascending, bypass Mongoose hydration

    res.status(200).json({
      makes,
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

// @desc get single make by id
// @route GET /api/makes/:id
// @access Private/Admin
const getMakeById = async (req, res) => {
  try {
    const make = await Make.findOne({
      _id: req.params.id,
      isDeleted: { $ne: true },
    });
    if (!make) {
      return res.status(404).json({ message: "Make not found" });
    }
    res.status(200).json(make);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Update a make
// @route   PUT /api/makes/:id
// @access  Private/Admin
const updateMake = async (req, res) => {
  try {
    const { name, shortName, description } = req.body;

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid make ID" });
    }

    // Omitted fields stay unchanged; sent fields must be valid.
    const invalid =
      (name !== undefined &&
        requiredTextError(name, "Make name", MAX_MAKE_NAME_LENGTH)) ||
      (shortName !== undefined &&
        requiredTextError(shortName, "Short name", MAX_MAKE_SHORT_NAME_LENGTH)) ||
      descriptionError(description);
    if (invalid) {
      return res.status(400).json({ message: invalid });
    }

    const make = await Make.findOne({
      _id: req.params.id,
      isDeleted: { $ne: true },
    });
    if (!make) {
      return res.status(404).json({ message: "Make not found" });
    }

    const same = (a, b) =>
      String(clean(a) || "").toLowerCase() === String(clean(b) || "").toLowerCase();

    // Duplicate checks only when the value actually changes, so editing the
    // description of an older make that already shares a short name still works.
    if (name !== undefined && !same(name, make.name)) {
      if (await findDuplicateMake("name", name, make._id)) {
        return res
          .status(400)
          .json({ message: "Make with this name already exists" });
      }
    }
    if (shortName !== undefined && !same(shortName, make.shortName)) {
      if (await findDuplicateMake("shortName", shortName, make._id)) {
        return res
          .status(400)
          .json({ message: "Make with this short name already exists" });
      }
    }

    if (name !== undefined) make.name = clean(name);
    if (shortName !== undefined) make.shortName = clean(shortName);
    if (description !== undefined) {
      make.description = typeof description === "string" ? description.trim() : "";
    }

    await make.save();

    const cacheService = require("../services/cache.service");
    cacheService.delPrefix("master:make");
    req.app.get("io")?.emit("cache:invalidate", { scope: "make" });

    res.status(200).json(make);
  } catch (error) {
    console.error(error);
    const known = saveErrorMessage(error);
    if (known) return res.status(400).json({ message: known });
    res.status(500).json({ message: "Server error" });
  }
};

const deleteMake = async (req, res) => {
  try {
    const make = await Make.findById(req.params.id, { isDeleted: false });
    if (!make) {
      return res.status(404).json({ message: "Make not found" });
    }

    make.isDeleted = true;
    make.deletedAt = new Date();
    await make.save();

    const cacheService = require("../services/cache.service");
    cacheService.delPrefix("master:make");
    req.app.get("io")?.emit("cache:invalidate", { scope: "make" });

    res.status(200).json({ message: "Make deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  createMake,
  getAllMakes,
  getMakeById,
  updateMake,
  deleteMake,
};
