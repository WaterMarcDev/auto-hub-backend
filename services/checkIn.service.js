/**
 * Check-in business logic. Extracted 1:1 from controllers/checkIn.js during
 * the clean-architecture migration — every rule, message, and status code
 * below is intentionally unchanged.
 *
 * NOTE on Invoice: this domain touches the Invoice model only inside
 * getInvoiceRenderData() (a "create if missing, then render" side path).
 * The Invoice domain has its own controller/repository/service being
 * migrated separately — to avoid two independent migrations racing to
 * create the same repositories/invoice.repository.js file, this service
 * uses a private, unshared BaseRepository instance scoped to this file
 * only, exactly mirroring the original code's own lazy
 * `require("../models/invoice.model")` pattern.
 */
const fs = require("fs");
const path = require("path");
const BaseRepository = require("../repositories/base.repository");
const checkInRepository = require("../repositories/checkIn.repository");
const transactionRepository = require("../repositories/transaction.repository");
const customerRepository = require("../repositories/customer.repository");

function httpError(statusCode, payload) {
  const err = new Error(payload.message || payload.error || "Error");
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

async function createCheckIn(body, user) {
  const {
    customer,
    type,
    transaction: transactionData,
    numberOfPersons,
    employeeSignature,
  } = body;

  if (!customer) throw httpError(400, { message: "customer is required" });
  if (!type) throw httpError(400, { message: "type is required" });
  if (!transactionData) throw httpError(400, { message: "transaction data is required" });

  // ensure customer exists
  const cust = await customerRepository.findById(customer);
  if (!cust) throw httpError(404, { message: "Customer not found" });

  // validate transaction data
  const { amount, paymentMethod } = transactionData;
  if (amount == null) {
    throw httpError(400, { message: "transaction.amount is required" });
  }
  if (!paymentMethod) {
    throw httpError(400, { message: "transaction.paymentMethod is required" });
  }

  // create transaction document with enforced fields
  const trx = transactionRepository.build({
    amount,
    paymentMethod,
    type: "credit",
    createdBy: user && user._id ? user._id : undefined,
  });
  await transactionRepository.save(trx);

  const checkIn = checkInRepository.build({
    customer,
    type,
    transaction: trx._id,
    numberOfPersons,
    employeeSignature,
    checkedInBy: user && user._id ? user._id : undefined,
  });

  await checkInRepository.save(checkIn);

  return checkInRepository
    .findById(checkIn._id)
    .populate("customer")
    .populate("transaction")
    .populate("checkedInBy", "name email");
}

async function getAllCheckIns({ page = 1, limit = 20, search, status } = {}) {
  const filter = {};
  if (status) filter.status = status;

  if (search) {
    // We'll search checkInToken and customer.name / customer.email via aggregation or $or with populate lookup.
    // Simpler approach: find customer IDs matching search, then filter.
    const custRegex = new RegExp(search, "i");
    const matchingCustomers = await customerRepository
      .find({
        $or: [
          { firstName: custRegex },
          { lastName: custRegex },
          { email: custRegex },
          { mobileNo: custRegex },
        ],
      })
      .select("_id");
    const custIds = matchingCustomers.map((c) => c._id);

    filter.$or = [
      { checkInToken: { $regex: search, $options: "i" } },
      { customer: { $in: custIds } },
    ];
  }

  const total = await checkInRepository.countDocuments(filter);
  const items = await checkInRepository
    .find(filter)
    .sort({ checkInTime: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate("customer")
    .populate("transaction")
    .populate("checkedInBy", "name email")
    .populate("checkedOutBy", "name email");

  return { page, limit, total, items };
}

async function checkout(id, user) {
  const checkIn = await checkInRepository.findById(id);
  if (!checkIn) throw httpError(404, { message: "CheckIn not found" });

  if (checkIn.status === "checked-out") {
    throw httpError(400, { message: "Already checked out" });
  }

  checkIn.status = "checked-out";
  checkIn.checkOutTime = new Date();
  checkIn.checkedOutBy = user && user._id ? user._id : undefined;

  await checkInRepository.save(checkIn);

  return checkInRepository
    .findById(checkIn._id)
    .populate("customer")
    .populate("transaction")
    .populate("checkedInBy", "name email")
    .populate("checkedOutBy", "name email");
}

/**
 * Prepares the data (and view name) for rendering the check-in invoice
 * template. Kept as a single function returning {view, data} so the
 * controller retains the actual `res.render(...)` call (a response-format
 * decision) while all data preparation/side effects live here.
 */
async function getInvoiceRenderData(id, user) {
  const checkIn = await checkInRepository
    .findById(id)
    .populate("customer")
    .populate("transaction")
    .populate("checkedInBy", "first_name last_name email");

  if (!checkIn) {
    const err = new Error("CheckIn not found");
    err.statusCode = 404;
    err.isPlainText = true; // original used res.status(404).send("CheckIn not found")
    throw err;
  }

  // Try to find an existing Invoice for this check-in (prefer most recent)
  let invoiceDoc = null;
  try {
    const InvoiceModel = require("../models/invoice.model");
    const invoiceRepository = new BaseRepository(InvoiceModel);

    invoiceDoc = await invoiceRepository
      .findOne({ checkIn: checkIn._id })
      .sort({ createdAt: -1 })
      .populate("transaction")
      .populate("createdBy", "first_name last_name email");

    // If no invoice exists, create one now
    if (!invoiceDoc) {
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
        transactionSnapshot: checkIn.transaction ? checkIn.transaction.toObject() : null,
      };

      const created = await invoiceRepository.create({
        checkIn: checkIn._id,
        transaction: checkIn.transaction?._id,
        invoiceData,
        paymentMethod: invoiceData.paymentMethod,
        amount: invoiceData.amount,
        amountPaid: invoiceData.amountPaid,
        taxRate: invoiceData.taxRate,
        invoiceDate: checkIn.checkInTime || new Date(),
        createdBy: user?._id,
      });

      // re-fetch populated doc
      invoiceDoc = await invoiceRepository
        .findById(created._id)
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
    generatedBy: user
      ? { id: user._id, name: user.first_name || user.name || "" }
      : null,
    logoSrc: logoDataUri || "/assets/logo-sm1.png",
  };

  // Mark invoice as printed
  checkIn.invoicePrinted = true;
  await checkInRepository.save(checkIn);

  return { view: "invoice.njk", data };
}

module.exports = {
  createCheckIn,
  getAllCheckIns,
  checkout,
  getInvoiceRenderData,
};
