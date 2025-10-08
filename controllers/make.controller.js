const Make = require("../models/Make");

// @desc    Create a new make
// @route   POST /api/makes
// @access  Private/Admin
const createMake = async (req, res) => {
  try {
    const { name, shortName, description } = req.body;

    // Check if make with the same name already exists
    const existingMake = await Make.findOne({ name });
    if (existingMake) {
      return res
        .status(400)
        .json({ message: "Make with this name already exists" });
    }

    const make = await Make.create({
      name,
      shortName,
      description,
    });

    res.status(201).json(make);
  } catch (error) {
    console.error(error);
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
    if (req.query.search) {
      filter.name = { $regex: req.query.search, $options: "i" };
    }

    const total = await Make.countDocuments(filter);
    const makes = await Make.find(filter)
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });

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

    const make = await Make.findById(req.params.id, { isDeleted: false });
    if (!make) {
      return res.status(404).json({ message: "Make not found" });
    }

    make.name = name || make.name;
    make.shortName = shortName || make.shortName;
    make.description = description || make.description;

    await make.save();
    res.status(200).json(make);
  } catch (error) {
    console.error(error);
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
