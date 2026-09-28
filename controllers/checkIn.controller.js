const CheckIn = require("../models/CheckIn.model");
const Transaction = require("../models/Transaction.model");
const Customer = require("../models/Customer.model");
const fs = require("fs");
const path = require("path");

// Create a new check-in. Expects body: { customer: ObjectId, transaction: { ...transactionData }, employeeSignature: string }
// checkInTime is automatic, checkedInBy is taken from req.user (assumes auth middleware sets req.user)
exports.create = async (req, res) => {
  try {
    const {
      customer,
      type,
      transaction: transactionData,
      numberOfPersons,
      employeeSignature,
    } = req.body;

    if (!customer)
      return res.status(400).json({ message: "customer is required" });
    if (!type)
      return res.status(400).json({ message: "type is required" });
    if (!transactionData)
      return res.status(400).json({ message: "transaction data is required" });

    // ensure customer exists
    const cust = await Customer.findById(customer);
    if (!cust) return res.status(404).json({ message: "Customer not found" });

    // validate transaction data
    const { amount, paymentMethod } = transactionData;
    if (amount == null) {
      return res
        .status(400)
        .json({ message: "transaction.amount is required" });
    }
    if (!paymentMethod) {
      return res
        .status(400)
        .json({ message: "transaction.paymentMethod is required" });
    }

    // create transaction document with enforced fields
    const trx = new Transaction({
      amount,
      paymentMethod,
      type: "credit",
      createdBy: req.user && req.user._id ? req.user._id : undefined,
    });
    await trx.save();

    const checkIn = new CheckIn({
      customer,
      type,
      transaction: trx._id,
      numberOfPersons,
      employeeSignature,
      checkedInBy: req.user && req.user._id ? req.user._id : undefined,
    });

    await checkIn.save();

    const populated = await CheckIn.findById(checkIn._id)
      .populate("customer")
      .populate("transaction")
      .populate("checkedInBy", "name email");

    return res.status(201).json(populated);
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
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

    const filter = {};
    if (status) filter.status = status;

    if (search) {
      // We'll search checkInToken and customer.name / customer.email via aggregation or $or with populate lookup.
      // Simpler approach: find customer IDs matching search, then filter.
      const custRegex = new RegExp(search, "i");
      const matchingCustomers = await Customer.find({
        $or: [
          { firstName: custRegex },
          { lastName: custRegex },
          { email: custRegex },
          { mobileNo: custRegex },
        ],
      }).select("_id");
      const custIds = matchingCustomers.map((c) => c._id);

      filter.$or = [
        { checkInToken: { $regex: search, $options: "i" } },
        { customer: { $in: custIds } },
      ];
    }

    const total = await CheckIn.countDocuments(filter);
    const items = await CheckIn.find(filter)
      .sort({ checkInTime: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("customer")
      .populate("transaction")
      .populate("checkedInBy", "name email")
      .populate("checkedOutBy", "name email");

    return res.json({ page, limit, total, items });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
};

// Update check-in to checkout. Sets status to 'checked-out', checkOutTime to now, checkedOutBy from req.user
exports.checkout = async (req, res) => {
  try {
    const id = req.params.id;
    const checkIn = await CheckIn.findById(id);
    if (!checkIn) return res.status(404).json({ message: "CheckIn not found" });

    if (checkIn.status === "checked-out") {
      return res.status(400).json({ message: "Already checked out" });
    }

    checkIn.status = "checked-out";
    checkIn.checkOutTime = new Date();
    checkIn.checkedOutBy = req.user && req.user._id ? req.user._id : undefined;

    await checkIn.save();

    const populated = await CheckIn.findById(checkIn._id)
      .populate("customer")
      .populate("transaction")
      .populate("checkedInBy", "name email")
      .populate("checkedOutBy", "name email");

    return res.json(populated);
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
};

// @desc    Print invoice for a check-in
// @access  Private
exports.printInvoice = async (req, res) => {
  try {
    const id = req.params.id;
    const checkIn = await CheckIn.findById(id)
      .populate("customer")
      .populate("transaction")
      .populate("checkedInBy", "first_name last_name email");

    if (!checkIn) return res.status(404).send("CheckIn not found");

    // Try to find an existing Invoice for this check-in (prefer most recent)
    let invoiceDoc = null;
    try {
      const InvoiceModel = require("../models/Invoice.model");
      invoiceDoc = await InvoiceModel.findOne({
        checkIn: checkIn._id,
      })
        .sort({ createdAt: -1 })
        .populate("transaction")
        .populate("createdBy", "first_name last_name email");

      // If no invoice exists, create one now
      if (!invoiceDoc) {
        const InvoiceModelInst = InvoiceModel;

        // Build invoice snapshot data
        const amount = (checkIn.transaction && checkIn.transaction.amount) || 0;
        const taxRate = 0; // No tax for check-in entry fees by default

        // Determine if payment was made (transaction exists and has amount)
        const amountPaid = checkIn.transaction?.amount || 0;

        const invoiceData = {
          amount,
          taxRate,
          amountPaid,
          paymentMethod: checkIn.transaction?.paymentMethod,
          checkInSnapshot: checkIn.toObject(),
          transactionSnapshot: checkIn.transaction
            ? checkIn.transaction.toObject()
            : null,
        };

        const created = await InvoiceModelInst.create({
          checkIn: checkIn._id,
          transaction: checkIn.transaction?._id,
          invoiceData,
          paymentMethod: invoiceData.paymentMethod,
          amount: invoiceData.amount,
          amountPaid: invoiceData.amountPaid,
          taxRate: invoiceData.taxRate,
          invoiceDate: checkIn.checkInTime || new Date(),
          createdBy: req.user?._id,
        });

        // re-fetch populated doc
        invoiceDoc = await InvoiceModelInst.findById(created._id)
          .populate("transaction")
          .populate("createdBy", "first_name last_name email");
      }
    } catch (e) {
      // Invoice model not available or creation failed - ignore
      console.warn("Invoice creation/check failed:", e && e.message);
      invoiceDoc = null;
    }

    // Load logo as base64 data URI
    let logoDataUri = null;
    try {
      const logoPath = path.join(__dirname, "..", "assets", "logo-sm1.png");
      if (fs.existsSync(logoPath)) {
        const buf = fs.readFileSync(logoPath);
        const b64 = buf.toString("base64");
        logoDataUri = `data:image/png;base64,${b64}`;
      }
    } catch (e) {
      console.warn("Could not read logo for invoice:", e && e.message);
      logoDataUri = null;
    }

    // Compute padded invoice string if invoice found
    const invoicePadded =
      invoiceDoc && invoiceDoc.invoiceNumber
        ? String(invoiceDoc.invoiceNumber).padStart(7, "0")
        : null;

    const data = {
      checkIn,
      customer: checkIn.customer,
      transaction: checkIn.transaction,
      invoiceDoc,
      invoicePadded,
      generatedAt: new Date(),
      generatedBy: req.user
        ? { id: req.user._id, name: req.user.first_name || req.user.name || "" }
        : null,
      logoSrc: logoDataUri || "/assets/logo-sm1.png",
    };

    // Mark invoice as printed
    checkIn.invoicePrinted = true;
    await checkIn.save();

    // Render using invoice template
    return res.render("invoice.njk", data);
  } catch (err) {
    console.error("Print invoice error:", err);
    return res.status(500).json({ error: "Server error rendering invoice" });
  }
};
