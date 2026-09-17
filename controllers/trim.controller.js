const trimService = require("../services/trim.service");

function handleError(res, error, fallbackMessage) {
  if (error && error.statusCode) {
    return res.status(error.statusCode).json({ message: error.message });
  }
  console.error(fallbackMessage || "Error:", error);
  return res.status(500).json({ message: fallbackMessage || "Server error" });
}

// @desc    Create a new trim
// @route   POST /api/trims
const createTrim = async (req, res) => {
  try {
    const trim = await trimService.createTrim(req.body);
    res.status(201).json({ message: "Trim created successfully", data: trim });
  } catch (error) {
    handleError(res, error, "Error creating trim:");
  }
};

// @desc    Get all trims
// @route   GET /api/trims
const getAllTrims = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const result = await trimService.getAllTrims({
      page,
      limit,
      search: req.query.search,
      make: req.query.make,
      model: req.query.model,
    });
    res.status(200).json(result);
  } catch (error) {
    handleError(res, error, "Error fetching trims:");
  }
};

// desc   Get trim by ID
// route  GET /api/trims/:id
// access Private/Admin
const getTrimById = async (req, res) => {
  try {
    const trim = await trimService.getTrimById(req.params.id);
    res.status(200).json(trim);
  } catch (error) {
    handleError(res, error, "Error fetching trim by ID:");
  }
};

// @desc    Update a trim
// @route   PUT /api/trims/:id
// @access  Private/Admin
const updateTrim = async (req, res) => {
  try {
    const trim = await trimService.updateTrim(req.params.id, req.body);
    res.status(200).json({ message: "Trim updated successfully", data: trim });
  } catch (error) {
    handleError(res, error, "Error updating trim:");
  }
};

const deleteTrim = async (req, res) => {
  try {
    await trimService.deleteTrim(req.params.id);
    res.status(200).json({ message: "Trim deleted successfully" });
  } catch (error) {
    handleError(res, error, "Error deleting trim:");
  }
};

module.exports = {
  createTrim,
  getAllTrims,
  getTrimById,
  updateTrim,
  deleteTrim,
};
