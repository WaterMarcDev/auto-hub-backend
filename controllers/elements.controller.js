const elementsService = require("../services/elements.service");

function handleError(res, error, logLabel, fallbackMessage) {
  if (error && error.statusCode) {
    return res.status(error.statusCode).json({ message: error.message });
  }
  console.error(logLabel, error);
  return res.status(500).json({ message: fallbackMessage });
}

// @desc    Create a new element
// @route   POST /api/elements
const createElement = async (req, res) => {
  try {
    const element = await elementsService.createElement(req.body);
    res.status(201).json({ message: "Element created successfully", data: element });
  } catch (error) {
    handleError(res, error, "Error creating element:", "Server error while creating element");
  }
};

// @desc    Get all elements
// @route   GET /api/elements
const getAllElements = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const result = await elementsService.getAllElements({ page, limit, search: req.query.search });
    res.status(200).json(result);
  } catch (error) {
    handleError(res, error, "Error fetching elements:", "Server error while fetching elements");
  }
};

// @desc    Get element by ID
// @route   GET /api/elements/:id
const getElementById = async (req, res) => {
  try {
    const element = await elementsService.getElementById(req.params.id);
    res.status(200).json(element);
  } catch (error) {
    handleError(res, error, "Error fetching element:", "Server error while fetching element");
  }
};

// @desc    Update element by ID
// @route   PUT /api/elements/:id
const updateElement = async (req, res) => {
  try {
    const element = await elementsService.updateElement(req.params.id, req.body);
    res.status(200).json({ message: "Element updated successfully", data: element });
  } catch (error) {
    handleError(res, error, "Error updating element:", "Server error while updating element");
  }
};

const deleteElement = async (req, res) => {
  try {
    await elementsService.deleteElement(req.params.id);
    res.status(200).json({ message: "Element deleted successfully" });
  } catch (error) {
    handleError(res, error, "Error deleting element:", "Server error while deleting element");
  }
};

module.exports = {
  createElement,
  getAllElements,
  getElementById,
  updateElement,
  deleteElement,
};
