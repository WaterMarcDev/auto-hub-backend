const Trim = require("../models/Trim.model");

// @desc    Create a new trim
// @route   POST /api/trims
const createTrim = async (req, res) => {
  try {
    const { name, make, model, shortName, description } = req.body;

    // Check if trim with the same name, make, and model already exists
    const existingTrim = await Trim.findOne({ name, make, model });
    if (existingTrim) {
      return res.status(400).json({
        message:
          "Trim with this name already exists for the specified make and model",
      });
    }

    const trim = await Trim.create({
      name,
      make,
      model,
      shortName,
      description,
    });

    res.status(201).json({
      message: "Trim created successfully",
      data: trim,
    });
  } catch (error) {
    console.error("Error creating trim:", error);
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

    if (req.query.search) {
      filter.name = { $regex: req.query.search, $options: "i" };
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
      .sort({ createdAt: -1 });

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
    const trim = await Trim.findById(req.params.id)
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
    const { name, make, model, shortName, description } = req.body;

    const trim = await Trim.findByIdAndUpdate(
      req.params.id,
      {
        name,
        make,
        model,
        shortName,
        description,
      },
      { new: true }
    )
      .populate("make")
      .populate("model");

    if (!trim) {
      return res.status(404).json({ message: "Trim not found" });
    }

    res.status(200).json({
      message: "Trim updated successfully",
      data: trim,
    });
  } catch (error) {
    console.error("Error updating trim:", error);
    res.status(500).json({
      message: "Server error while updating trim",
    });
  }
};

module.exports = {
  createTrim,
  getAllTrims,
  getTrimById,
  updateTrim,
};
