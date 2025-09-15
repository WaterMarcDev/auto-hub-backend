const Element = require("../models/elements.model");

// @desc    Create a new element
// @route   POST /api/elements
const createElement = async (req, res) => {
  try {
    const { name, shortName, weight, dimensions, description } = req.body;

    // Check if element with the same name already exists
    const existingElement = await Element.findOne({ name });
    if (existingElement) {
      return res.status(400).json({
        message: "Element with this name already exists",
      });
    }

    const element = await Element.create({
      name,
      shortName,
      weight,
      dimensions,
      description,
    });

    res.status(201).json({
      message: "Element created successfully",
      data: element,
    });
  } catch (error) {
    console.error("Error creating element:", error);
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
    if (req.query.search) {
      filter.name = { $regex: req.query.search, $options: "i" };
    }
    const elements = await Element.find(filter).skip(skip).limit(limit);
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
    const element = await Element.findById(req.params.id);
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
    const { name, shortName, weight, dimensions, description } = req.body;

    const element = await Element.findByIdAndUpdate(
      req.params.id,
      {
        name,
        shortName,
        weight,
        dimensions,
        description,
      },
      { new: true }
    );

    if (!element) {
      return res.status(404).json({ message: "Element not found" });
    }

    res.status(200).json({
      message: "Element updated successfully",
      data: element,
    });
  } catch (error) {
    console.error("Error updating element:", error);
    res.status(500).json({
      message: "Server error while updating element",
    });
  }
};

module.exports = {
  createElement,
  getAllElements,
  getElementById,
  updateElement,
};
