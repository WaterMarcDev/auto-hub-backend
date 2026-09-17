const elementHubService = require("../services/elementHub.service");

// Get all hub items (simple list)
const getAllHubItems = async (req, res) => {
  try {
    const items = await elementHubService.getAllHubItems();
    res.status(200).json(items);
  } catch (error) {
    console.error("Error fetching element hub items:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Get history for an elementHub or by elementName
const getHistory = async (req, res) => {
  try {
    const { id } = req.params; // can be hubId
    const history = await elementHubService.getHistory(id, req.query);
    res.status(200).json(history);
  } catch (error) {
    console.error("Error fetching hub history:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Sell (reduce) from hub
const sellElement = async (req, res) => {
  try {
    const result = await elementHubService.sellElement(req.body, req.user);
    res.status(200).json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    console.error("Error selling element:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Internal helper to add amount (used by scrap element creation)
const addToHubInternal = elementHubService.addToHubInternal;

// Print invoice for an element sell transaction
// @route   GET /api/element-hub/history/:id/print-invoice
// @access  Private
const printInvoice = async (req, res) => {
  try {
    const data = await elementHubService.buildPrintInvoiceData(req.params.id, req.user);
    return res.render("invoice.njk", data);
  } catch (err) {
    if (err.statusCode && err.plainText) {
      return res.status(err.statusCode).send(err.message);
    }
    console.error("Print element sell invoice error:", err);
    return res.status(500).json({ error: "Server error rendering invoice" });
  }
};

module.exports = {
  getAllHubItems,
  getHistory,
  sellElement,
  printInvoice,
  addToHubInternal,
};
