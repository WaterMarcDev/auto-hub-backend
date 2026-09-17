const modelService = require("../services/model.service");

function handleError(res, error, fallbackMessage) {
  if (error && error.statusCode) {
    return res.status(error.statusCode).json({ message: error.message });
  }
  console.error(error);
  return res.status(500).json({ message: fallbackMessage || "Server error" });
}

// @desc    Create a new model
// @route   POST /api/models
// @access  Private/Admin
const createModel = async (req, res) => {
  try {
    const model = await modelService.createModel(req.body);
    res.status(201).json(model);
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Get all models
// @route   GET /api/models
// @access  Private/Admin
const getAllModels = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const result = await modelService.getAllModels({
      page,
      limit,
      search: req.query.search,
      make: req.query.make,
    });
    res.status(200).json(result);
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Get model by ID
// @route   GET /api/models/:id
// @access  Private/Admin
const getModelById = async (req, res) => {
  try {
    const model = await modelService.getModelById(req.params.id);
    res.status(200).json(model);
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Update a model
// @route   PUT /api/models/:id
// @access  Private/Admin
const updateModel = async (req, res) => {
  try {
    const model = await modelService.updateModel(req.params.id, req.body);
    res.status(200).json(model);
  } catch (error) {
    handleError(res, error);
  }
};

const deleteModel = async (req, res) => {
  try {
    await modelService.deleteModel(req.params.id);
    res.status(200).json({ message: "Model soft-deleted successfully" });
  } catch (error) {
    handleError(res, error);
  }
};

module.exports = {
  createModel,
  getAllModels,
  getModelById,
  updateModel,
  deleteModel,
};
