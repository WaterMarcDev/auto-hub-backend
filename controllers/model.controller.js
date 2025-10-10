const CarModel = require("../models/Model.model");

// @desc    Create a new model
// @route   POST /api/models
// @access  Private/Admin
const createModel = async (req, res) => {
  try {
    const { name, make, shortName, description } = req.body;

    // Check if model with the same name and make already exists
    const existingModel = await CarModel.findOne({ name, make });
    if (existingModel) {
      return res.status(400).json({
        message: "Model with this name already exists for the specified make",
      });
    }

    const model = await CarModel.create({
      name,
      make,
      shortName,
      description,
    });

    res.status(201).json(model);
  } catch (error) {
    console.error(error);
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

    if (req.query.search) {
      filter.name = { $regex: req.query.search, $options: "i" };
    }

    if (req.query.make) {
      filter.make = req.query.make;
    }

    const total = await CarModel.countDocuments(filter);
    const models = await CarModel.find(filter)
      .populate("make")
      .skip(skip)
      .limit(limit)
      .sort({ name: 1 });

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
    const model = await CarModel.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
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

const deleteModel = async (req, res) => {
  try {
    const model = await CarModel.findById(req.params.id);
    if (!model || model.isDeleted) {
      return res.status(404).json({ message: "Model not found" });
    }

    model.isDeleted = true;
    model.deletedAt = new Date();
    await model.save();

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
