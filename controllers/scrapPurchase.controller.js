// Scrap Material Purchase controller — fully independent.
//
// Reuses ONLY the proven print/rendering infrastructure pattern:
//   server-rendered Nunjucks template + res.render + ?autoPrint=1 iframe.
// It does NOT import or touch PaymentSlip, Invoice, CarIntake, or Transaction.

const scrapPurchaseService = require("../services/scrapPurchase.service");
const { ScrapItemValidationError } = scrapPurchaseService;

function handleError(res, error, label) {
  if (error instanceof ScrapItemValidationError) {
    return res.status(400).json({ message: error.message });
  }
  if (error.statusCode) {
    return res.status(error.statusCode).json({ message: error.message });
  }
  console.error(label, error);
  return res.status(500).json({ message: "Server error" });
}

// @desc   Create a scrap material purchase
// @route  POST /api/scrap-purchase
// @access Private (auth)
const createScrapPurchase = async (req, res) => {
  try {
    const created = await scrapPurchaseService.createScrapPurchase(req.body, req.user ? req.user._id : undefined);
    return res.status(201).json(created);
  } catch (error) {
    return handleError(res, error, "Error creating scrap purchase:");
  }
};

// @desc   List scrap purchases (paginated + optional search)
// @route  GET /api/scrap-purchase
// @access Private (auth)
const getScrapPurchases = async (req, res) => {
  try {
    const result = await scrapPurchaseService.getScrapPurchases(req.query);
    return res.json(result);
  } catch (error) {
    console.error("Error listing scrap purchases:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// @desc   Get a single scrap purchase
// @route  GET /api/scrap-purchase/:id
// @access Private (auth)
const getScrapPurchaseById = async (req, res) => {
  try {
    const record = await scrapPurchaseService.getScrapPurchaseById(req.params.id);
    return res.json(record);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    console.error("Error fetching scrap purchase:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// @desc   Update a scrap purchase / edit its bill line items before printing
// @route  PUT /api/scrap-purchase/:id
// @access Private (auth)
const updateScrapPurchase = async (req, res) => {
  try {
    const record = await scrapPurchaseService.updateScrapPurchase(req.params.id, req.body);
    return res.json(record);
  } catch (error) {
    return handleError(res, error, "Error updating scrap purchase:");
  }
};

// @desc   Soft-delete a scrap purchase
// @route  DELETE /api/scrap-purchase/:id
// @access Private (auth)
const deleteScrapPurchase = async (req, res) => {
  try {
    await scrapPurchaseService.deleteScrapPurchase(req.params.id);
    return res.json({ message: "Scrap purchase deleted", id: req.params.id });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    console.error("Error deleting scrap purchase:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// @desc   Render the scrap purchase bill (HTML, printable; ?autoPrint=1 triggers
//         the browser print dialog via the same proven pattern used elsewhere)
// @route  GET /api/scrap-purchase/:id/print
// @access Private (auth)
const printScrapPurchase = async (req, res) => {
  try {
    const data = await scrapPurchaseService.buildPrintScrapPurchaseData(req.params.id, req.user);
    return res.render("scrapPurchaseBill.njk", data);
  } catch (error) {
    if (error.statusCode && error.plainText) {
      return res.status(error.statusCode).send(error.message);
    }
    console.error("Error printing scrap purchase:", error);
    return res.status(500).json({ error: "Server error rendering scrap purchase bill" });
  }
};

module.exports = {
  createScrapPurchase,
  getScrapPurchases,
  getScrapPurchaseById,
  updateScrapPurchase,
  deleteScrapPurchase,
  printScrapPurchase,
};
