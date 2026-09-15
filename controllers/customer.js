const Customer = require("../models/customer");

// Validates a US-style phone number. Accepts 10 digits, or 11 digits with a
// leading country code 1, allowing spaces, dashes, parentheses, dots and a
// leading "+". Any value containing letters is rejected. Kept as a local
// helper (NOT a schema validator) so the shared Customer schema and all
// unrelated customer/vehicle workflows remain fully backward compatible.
const isValidUsPhone = (value) => {
  if (value === undefined || value === null) return false;
  const raw = String(value).trim();
  if (!raw) return false;
  if (/[a-zA-Z]/.test(raw)) return false;
  const cleaned = raw.replace(/[\s\-().+]/g, "");
  if (!/^\d+$/.test(cleaned)) return false;
  return /^\d{10}$/.test(cleaned) || /^1\d{10}$/.test(cleaned);
};

const createCustomer = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      mobileNo,
      email,
      type,
      idProofType,
      idProofNumber,
      idProofImage,
      signatureImage,
    } = req.body;

    // Optional Seller/Buyer discriminator. When supplied it must be valid;
    // when omitted/blank (legacy callers / generic customers) the record is
    // still created with no type, for backward compatibility.
    let normalizedType;
    if (type !== undefined && type !== null && type !== "") {
      if (!["seller", "buyer"].includes(type)) {
        return res.status(400).json({
          error: "Invalid type",
          details: "type must be either 'seller' or 'buyer'",
        });
      }
      normalizedType = type;
    }

    // Seller-specific phone validation. Scoped to type "seller" only so
    // generic/legacy customers and unrelated flows are unaffected. This stops
    // invalid values from bypassing the frontend by calling POST /customers
    // directly.
    if (normalizedType === "seller" && !isValidUsPhone(mobileNo)) {
      return res.status(400).json({
        error: "Please enter a valid US phone number.",
      });
    }

    const newCustomer = new Customer({
      firstName,
      lastName,
      mobileNo,
      email,
      type: normalizedType,
      idProofType,
      idProofNumber,
      idProofImage,
      signatureImage,
      createdBy: req.user._id,
    });

    await newCustomer.save();
    res.status(201).json(newCustomer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAllCustomers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const filter = {};
    filter.isDeleted = { $ne: true };

    // Optional Seller/Buyer discriminator filter. The Scrap Purchase supplier
    // dropdown requests ?type=seller; honor it (restricted to the known enum
    // values) without altering any other filtering behavior or the response
    // shape. When omitted, behavior is exactly as before.
    if (req.query.type === "seller" || req.query.type === "buyer") {
      filter.type = req.query.type;
    }

    if (req.query.search) {
      const searchRegex = new RegExp(req.query.search, "i");
      filter.$or = [
        { firstName: searchRegex },
        { lastName: searchRegex },
        { email: searchRegex },
        { mobileNo: searchRegex },
      ];
    }
    const customers = await Customer.find(filter)
      .populate({
        path: "carIntakes",
        options: { sort: { createdAt: -1 } },
      })
      .skip(skip)
      .limit(limit);
    const total = await Customer.countDocuments(filter);
    res.status(200).json({ customers, pagination: { page, limit, total } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getCustomerById = async (req, res) => {
  try {
    const customer = await Customer.findOne({
      _id: req.params.id,
      isDeleted: { $ne: true },
    });
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }
    res.status(200).json(customer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateCustomerById = async (req, res) => {
  try {
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, isDeleted: { $ne: true } },
      req.body,
      { new: true }
    );
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }
    res.status(200).json(customer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteCustomerById = async (req, res) => {
  try {
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, isDeleted: { $ne: true } },
      { isDeleted: true, deletedAt: new Date() },
      { new: true }
    );
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }
    res.status(200).json({ message: "Customer deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createCustomer,
  getAllCustomers,
  getCustomerById,
  updateCustomerById,
  deleteCustomerById,
};
