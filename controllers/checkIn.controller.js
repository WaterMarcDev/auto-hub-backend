const mongoose = require("mongoose");
const CheckIn = require("../models/CheckIn.model");
const Transaction = require("../models/Transaction.model");
const Customer = require("../models/Customer.model");
const fs = require("fs");
const path = require("path");

// People entering with the customer, at most.
const MAX_EXTRA_PERSONS = 20;

// Error message for the persons' details, or null when they are valid.
// Returns { error } or { persons } (cleaned).
function checkPersons(numberOfPersons, persons) {
  const n = numberOfPersons === undefined || numberOfPersons === null || numberOfPersons === ""
    ? 0
    : Number(numberOfPersons);
  if (!Number.isInteger(n) || n < 0 || n > MAX_EXTRA_PERSONS) {
    return { error: `Number of Persons must be a whole number from 0 to ${MAX_EXTRA_PERSONS}` };
  }
  const list = Array.isArray(persons) ? persons : [];
  if (list.length !== n) {
    return { error: `Details are needed for all ${n} persons (got ${list.length})` };
  }
  const cleaned = [];
  for (let i = 0; i < n; i++) {
    const p = list[i] || {};
    const fullName = typeof p.fullName === "string" ? p.fullName.trim().replace(/\s{2,}/g, " ") : "";
    const digits = String(p.mobileNo || "").replace(/\D/g, "");
    const signature = typeof p.signature === "string" ? p.signature.trim() : "";
    if (!fullName) return { error: `Person ${i + 1}: Full Name is required` };
    if (fullName.length > 100) return { error: `Person ${i + 1}: Full Name can be at most 100 characters` };
    if (digits.length !== 10) return { error: `Person ${i + 1}: Mobile No. must be a 10-digit US number` };
    if (!signature) return { error: `Person ${i + 1}: Signature is required` };
    cleaned.push({
      fullName,
      mobileNo: `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`,
      signature,
    });
  }
  return { numberOfPersons: n, persons: cleaned };
}

// U-Pull form: entry amount limits, in dollars.
const CHECKIN_AMOUNT_MIN = 1;
const CHECKIN_AMOUNT_MAX = 10;

// Money: at most 2 decimal places.
const isWholeCents = (n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

// Create a new check-in. Expects body: { customer: ObjectId, transaction: { ...transactionData }, employeeSignature: string }
// checkInTime is automatic, checkedInBy is taken from req.user (assumes auth middleware sets req.user)
exports.create = async (req, res) => {
  try {
    const {
      customer,
      type,
      transaction: transactionData,
      numberOfPersons,
      persons,
      employeeSignature,
      employeeName,
    } = req.body;

    // Both `message` and `error`: the frontend shows `error`.
    const bad = (status, text) => res.status(status).json({ message: text, error: text });
    if (!customer) return bad(400, "Please select a customer");
    if (!mongoose.isValidObjectId(customer)) return bad(400, "Please select a valid customer");
    if (!type) return bad(400, "type is required");
    if (!transactionData || typeof transactionData !== "object")
      return bad(400, "transaction data is required");

    // ensure customer exists
    const cust = await Customer.findById(customer);
    if (!cust) return bad(404, "Customer not found");

    // validate transaction data
    const { amount, paymentMethod } = transactionData;
    if (amount == null || amount === "") return bad(400, "Please enter the amount");
    if (!paymentMethod) return bad(400, "Please select the type of payment");

    // U-Pull form: the entry amount is $1 – $10, in dollars and cents.
    const numericAmount = typeof amount === "boolean" ? NaN : Number(amount);
    if (Number.isFinite(numericAmount) && !isWholeCents(numericAmount)) {
      return bad(400, "Amount can have at most 2 decimal places");
    }
    if (!Number.isFinite(numericAmount) || numericAmount < CHECKIN_AMOUNT_MIN || numericAmount > CHECKIN_AMOUNT_MAX) {
      return res.status(400).json({
        message: `Amount must be between $${CHECKIN_AMOUNT_MIN} and $${CHECKIN_AMOUNT_MAX}`,
        error: `Amount must be between $${CHECKIN_AMOUNT_MIN} and $${CHECKIN_AMOUNT_MAX}`,
      });
    }
    const personsCheck = checkPersons(numberOfPersons, persons);
    if (personsCheck.error) {
      return res.status(400).json({ message: personsCheck.error, error: personsCheck.error });
    }
    const cleanEmployeeName = typeof employeeName === "string" ? employeeName.trim() : "";
    if (!cleanEmployeeName) {
      return res.status(400).json({ message: "Name of Employee is required", error: "Name of Employee is required" });
    }
    if (typeof employeeSignature !== "string" || !employeeSignature.trim()) {
      return res.status(400).json({ message: "Signature of employee is required", error: "Signature of employee is required" });
    }

    // create transaction document with enforced fields
    const trx = new Transaction({
      amount: numericAmount,
      paymentMethod,
      type: "credit",
      createdBy: req.user && req.user._id ? req.user._id : undefined,
    });
    await trx.save();

    const checkIn = new CheckIn({
      customer,
      type,
      transaction: trx._id,
      numberOfPersons: personsCheck.numberOfPersons,
      persons: personsCheck.persons,
      employeeSignature,
      // Payment is mandatory and taken at check-in (Type of Payment + Amount).
      paidBeforeEntry: true,
      employeeName: cleanEmployeeName.slice(0, 100),
      checkedInBy: req.user && req.user._id ? req.user._id : undefined,
    });

    await checkIn.save();

    const populated = await CheckIn.findById(checkIn._id)
      .populate("customer")
      .populate("transaction")
      .populate("checkedInBy", "name email");

    // Invalidate dashboard micro-cache and notify connected staff via WebSocket
    const cacheService = require("../services/cache.service");
    cacheService.delPrefix("dash:");
    req.app.get("io")?.emit("cache:invalidate", { scope: "checkins", item: populated });

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
      .populate("checkedOutBy", "name email")
      .lean();

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

    // Validate only what checkout changes, so older check-ins (saved before
    // the current field rules) can still be checked out.
    await checkIn.save({ validateModifiedOnly: true });

    const populated = await CheckIn.findById(checkIn._id)
      .populate("customer")
      .populate("transaction")
      .populate("checkedInBy", "name email")
      .populate("checkedOutBy", "name email");

    // Invalidate dashboard micro-cache and notify connected staff via WebSocket
    const cacheService = require("../services/cache.service");
    cacheService.delPrefix("dash:");
    req.app.get("io")?.emit("cache:invalidate", { scope: "checkins", item: populated });

    return res.json(populated);
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
};

// In-memory cache for invoice logo
let cachedLogoDataUri = null;
const getLogoDataUri = () => {
  if (cachedLogoDataUri) return cachedLogoDataUri;
  try {
    const logoPath = path.join(__dirname, "..", "assets", "logo-sm1.png");
    if (fs.existsSync(logoPath)) {
      const buf = fs.readFileSync(logoPath);
      cachedLogoDataUri = `data:image/png;base64,${buf.toString("base64")}`;
    }
  } catch (e) {
    console.warn("Could not read logo for invoice:", e && e.message);
  }
  return cachedLogoDataUri;
};

// @desc    Print invoice for a check-in
// @access  Private
exports.printInvoice = async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) return res.status(404).send("CheckIn not found");
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

    // Load logo as base64 data URI (cached)
    const logoDataUri = getLogoDataUri();

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

    // Mark invoice as printed. Only this flag is written: a full
    // checkIn.save() re-validates the whole document and failed (500, no
    // invoice) for older check-ins, e.g. a negative Number of Persons or a
    // deleted customer/transaction (populated as null).
    try {
      await CheckIn.updateOne({ _id: checkIn._id }, { $set: { invoicePrinted: true } });
    } catch (e) {
      console.warn("Could not mark check-in invoice as printed:", e && e.message);
    }

    // Render using invoice template. Template errors are answered here
    // instead of falling through to the JSON error handler.
    return res.render("invoice.njk", data, (renderErr, html) => {
      if (renderErr) {
        console.error("Print invoice render error:", renderErr);
        return res.status(500).send("Could not create the invoice. Please try again.");
      }
      return res.send(html);
    });
  } catch (err) {
    console.error("Print invoice error:", err);
    return res.status(500).json({ error: "Server error rendering invoice" });
  }
};
