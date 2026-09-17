const makeService = require("../services/make.service");

function handleError(res, error) {
  if (error && error.statusCode) {
    return res.status(error.statusCode).json({ message: error.message });
  }
  console.error(error);
  return res.status(500).json({ message: "Server error" });
}

// @desc    Create a new make
// @route   POST /api/makes
// @access  Private/Admin
const createMake = async (req, res) => {
  try {
    const make = await makeService.createMake(req.body);
    res.status(201).json(make);
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Get all makes
// @route   GET /api/makes
// @access  Private/Admin
const getAllMakes = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const result = await makeService.getAllMakes({
      page,
      limit,
      search: req.query.search,
    });
    res.status(200).json(result);
  } catch (error) {
    handleError(res, error);
  }
};

// @desc get single make by id
// @route GET /api/makes/:id
// @access Private/Admin
const getMakeById = async (req, res) => {
  try {
    const make = await makeService.getMakeById(req.params.id);
    res.status(200).json(make);
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Update a make
// @route   PUT /api/makes/:id
// @access  Private/Admin
const updateMake = async (req, res) => {
  try {
    const make = await makeService.updateMake(req.params.id, req.body);
    res.status(200).json(make);
  } catch (error) {
    handleError(res, error);
  }
};

const deleteMake = async (req, res) => {
  try {
    await makeService.deleteMake(req.params.id);
    res.status(200).json({ message: "Make deleted successfully" });
  } catch (error) {
    handleError(res, error);
  }
};

module.exports = {
  createMake,
  getAllMakes,
  getMakeById,
  updateMake,
  deleteMake,
};
