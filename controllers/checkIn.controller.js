const checkInService = require("../services/checkIn.service");

// Create a new check-in. Expects body: { customer: ObjectId, transaction: { ...transactionData }, employeeSignature: string }
// checkInTime is automatic, checkedInBy is taken from req.user (assumes auth middleware sets req.user)
exports.create = async (req, res) => {
  try {
    const populated = await checkInService.createCheckIn(req.body, req.user);
    return res.status(201).json(populated);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json(err.payload);
    console.error(err);
    return res.status(500).json({ message: "Internal server error", error: err.message });
  }
};

// Get all check-ins with pagination, search on customer data and checkInToken, filter by status
// Query params: page, limit, search, status
exports.getAll = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const search = req.query.search ? req.query.search.trim() : null;
    const status = req.query.status;

    const result = await checkInService.getAllCheckIns({ page, limit, search, status });
    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Internal server error", error: err.message });
  }
};

// Update check-in to checkout. Sets status to 'checked-out', checkOutTime to now, checkedOutBy from req.user
exports.checkout = async (req, res) => {
  try {
    const populated = await checkInService.checkout(req.params.id, req.user);
    return res.json(populated);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json(err.payload);
    console.error(err);
    return res.status(500).json({ message: "Internal server error", error: err.message });
  }
};

// @desc    Print invoice for a check-in
// @access  Private
exports.printInvoice = async (req, res) => {
  try {
    const { view, data } = await checkInService.getInvoiceRenderData(req.params.id, req.user);
    return res.render(view, data);
  } catch (err) {
    if (err.statusCode === 404 && err.isPlainText) {
      return res.status(404).send("CheckIn not found");
    }
    console.error("Print invoice error:", err);
    return res.status(500).json({ error: "Server error rendering invoice" });
  }
};
