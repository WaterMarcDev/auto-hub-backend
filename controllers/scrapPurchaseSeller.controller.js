// Scrap Material Purchase — dedicated seller controller (thin HTTP layer).
// See services/scrapPurchaseSeller.service.js for the business logic this
// controller previously held directly.
const scrapPurchaseSellerService = require("../services/scrapPurchaseSeller.service");

function handleError(res, error, logPrefix) {
  if (error && error.statusCode) {
    return res.status(error.statusCode).json(error.payload);
  }
  console.error(logPrefix, error);
  return res.status(500).json({ message: "Server error" });
}

// @desc   Create a scrap purchase seller
// @route  POST /api/scrap-purchase-sellers
// @access Private (auth)
const createScrapPurchaseSeller = async (req, res) => {
  try {
    const seller = await scrapPurchaseSellerService.createScrapPurchaseSeller(req.body);
    return res.status(201).json(seller);
  } catch (error) {
    handleError(res, error, "Error creating scrap purchase seller:");
  }
};

// @desc   List scrap purchase sellers (paginated + optional search)
// @route  GET /api/scrap-purchase-sellers
// @access Private (auth)
const getScrapPurchaseSellers = async (req, res) => {
  try {
    const result = await scrapPurchaseSellerService.getScrapPurchaseSellers(req.query);
    return res.json(result);
  } catch (error) {
    handleError(res, error, "Error listing scrap purchase sellers:");
  }
};

// @desc   Get a single scrap purchase seller
// @route  GET /api/scrap-purchase-sellers/:id
// @access Private (auth)
const getScrapPurchaseSellerById = async (req, res) => {
  try {
    const seller = await scrapPurchaseSellerService.getScrapPurchaseSellerById(req.params.id);
    return res.json(seller);
  } catch (error) {
    handleError(res, error, "Error fetching scrap purchase seller:");
  }
};

// @desc   Update a scrap purchase seller
// @route  PUT /api/scrap-purchase-sellers/:id
// @access Private (auth)
const updateScrapPurchaseSeller = async (req, res) => {
  try {
    const seller = await scrapPurchaseSellerService.updateScrapPurchaseSeller(req.params.id, req.body);
    return res.json(seller);
  } catch (error) {
    handleError(res, error, "Error updating scrap purchase seller:");
  }
};

// @desc   Permanently delete a scrap purchase seller
// @route  DELETE /api/scrap-purchase-sellers/:id
// @access Private (auth)
const deleteScrapPurchaseSeller = async (req, res) => {
  try {
    const seller = await scrapPurchaseSellerService.deleteScrapPurchaseSeller(req.params.id);
    return res.json({ message: "Seller permanently deleted", seller });
  } catch (error) {
    handleError(res, error, "Error deleting scrap purchase seller:");
  }
};

module.exports = {
  createScrapPurchaseSeller,
  getScrapPurchaseSellers,
  getScrapPurchaseSellerById,
  updateScrapPurchaseSeller,
  deleteScrapPurchaseSeller,
};
