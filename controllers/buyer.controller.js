const buyerService = require("../services/buyer.service");

function handleError(res, error, logLabel, fallbackStatus = 500) {
  if (error && error.statusCode) {
    return res.status(error.statusCode).json({ message: error.message });
  }
  if (logLabel) console.log(logLabel, error);
  const body = { message: "Server error" };
  if (logLabel) body.details = error.message;
  return res.status(fallbackStatus).json(body);
}

// @desc    Create new buyer
// @route   POST /api/buyers
// @access  Private
const createBuyer = async (req, res) => {
  try {
    const buyer = await buyerService.createBuyer({
      ...req.body,
      createdBy: req.user._id,
    });
    res.status(201).json(buyer);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    res.status(500).json({ message: "Server error" });
  }
};

const getBuyers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const result = await buyerService.getBuyers({ page, limit, search: req.query.search });
    res.status(200).json(result);
  } catch (error) {
    console.error("Get buyers error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

const getBuyerById = async (req, res) => {
  try {
    const buyer = await buyerService.getBuyerById(req.params.id);
    res.status(200).json(buyer);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    console.error("Get buyer by ID error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

const updateBuyer = async (req, res) => {
  try {
    const buyer = await buyerService.updateBuyer(req.params.id, req.body, req.user._id);
    res.status(200).json(buyer);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    console.log("Update buyer error", error);
    res.status(500).json({ message: "Server error", details: error.message });
  }
};

const deleteBuyer = async (req, res) => {
  try {
    await buyerService.deleteBuyer(req.params.id, req.user._id);
    res.status(200).json({ message: "Buyer deleted successfully" });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    console.log("Delete buyer error", error);
    res.status(500).json({ message: "Server error", details: error.message });
  }
};

module.exports = {
  createBuyer,
  getBuyers,
  getBuyerById,
  updateBuyer,
  deleteBuyer,
};
