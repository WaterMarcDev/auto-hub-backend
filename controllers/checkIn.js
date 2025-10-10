const CheckIn = require("../models/checkIn");
const Transaction = require("../models/Transaction");
const Customer = require("../models/customer");

// Create a new check-in. Expects body: { customer: ObjectId, transaction: { ...transactionData }, employeeSignature: string }
// checkInTime is automatic, checkedInBy is taken from req.user (assumes auth middleware sets req.user)
exports.create = async (req, res) => {
  try {
    const {
      customer,
      transaction: transactionData,
      numberOfPersons,
      employeeSignature,
    } = req.body;

    if (!customer)
      return res.status(400).json({ message: "customer is required" });
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
        $or: [{ name: custRegex }, { email: custRegex }, { phone: custRegex }],
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
