const partService = require("../services/part.service");

function handleError(res, error, logLabel, fallbackMessage) {
  if (error && error.statusCode) {
    return res.status(error.statusCode).json({ message: error.message });
  }
  console.error(logLabel, error);
  return res.status(500).json({ message: fallbackMessage });
}

// @desc    Create a new part
// @route   POST /api/parts
const createPart = async (req, res) => {
  try {
    const part = await partService.createPart(req.body);
    res.status(201).json({ message: "Part created successfully", data: part });
  } catch (error) {
    handleError(res, error, "Error creating part:", "Server error while creating part");
  }
};

// @desc    Get all parts
// @route   GET /api/parts
const getAllParts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const result = await partService.getAllParts({ page, limit, search: req.query.search });
    res.status(200).json(result);
  } catch (error) {
    handleError(res, error, "Error retrieving parts:", "Server error while retrieving parts");
  }
};

// @desc    Get part by ID
// @route   GET /api/parts/:id
const getPartById = async (req, res) => {
  try {
    const part = await partService.getPartById(req.params.id);
    res.status(200).json(part);
  } catch (error) {
    handleError(res, error, "Error retrieving part:", "Server error while retrieving part");
  }
};

// @desc    Update part by ID
// @route   PUT /api/parts/:id
const updatePart = async (req, res) => {
  try {
    const part = await partService.updatePart(req.params.id, req.body);
    res.status(200).json({ message: "Part updated successfully", data: part });
  } catch (error) {
    handleError(res, error, "Error updating part:", "Server error while updating part");
  }
};

// @desc    Delete part by ID
// @route   DELETE /api/parts/:id
const deletePart = async (req, res) => {
  try {
    await partService.deletePart(req.params.id);
    res.status(200).json({ message: "Part deleted successfully" });
  } catch (error) {
    handleError(res, error, "Error deleting part:", "Server error while deleting part");
  }
};

module.exports = {
  createPart,
  getAllParts,
  getPartById,
  updatePart,
  deletePart,
};
