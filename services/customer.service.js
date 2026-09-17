/**
 * Customer business logic. Extracted 1:1 from controllers/customer.js
 * during the clean-architecture migration — every rule, message, and
 * status code below is intentionally unchanged.
 */
const customerRepository = require("../repositories/customer.repository");

function httpError(statusCode, payload) {
  const err = new Error(payload.message || payload.error);
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

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

async function createCustomer(body, userId) {
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
  } = body;

  // Optional Seller/Buyer discriminator. When supplied it must be valid;
  // when omitted/blank (legacy callers / generic customers) the record is
  // still created with no type, for backward compatibility.
  let normalizedType;
  if (type !== undefined && type !== null && type !== "") {
    if (!["seller", "buyer"].includes(type)) {
      throw httpError(400, {
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
    throw httpError(400, { error: "Please enter a valid US phone number." });
  }

  const newCustomer = customerRepository.build({
    firstName,
    lastName,
    mobileNo,
    email,
    type: normalizedType,
    idProofType,
    idProofNumber,
    idProofImage,
    signatureImage,
    createdBy: userId,
  });

  await customerRepository.save(newCustomer);
  return newCustomer;
}

async function getAllCustomers({ page = 1, limit = 10, type, search } = {}) {
  const skip = (page - 1) * limit;

  const filter = {};
  filter.isDeleted = { $ne: true };

  // Optional Seller/Buyer discriminator filter. The Scrap Purchase supplier
  // dropdown requests ?type=seller; honor it (restricted to the known enum
  // values) without altering any other filtering behavior or the response
  // shape. When omitted, behavior is exactly as before.
  if (type === "seller" || type === "buyer") {
    filter.type = type;
  }

  if (search) {
    const searchRegex = new RegExp(search, "i");
    filter.$or = [
      { firstName: searchRegex },
      { lastName: searchRegex },
      { email: searchRegex },
      { mobileNo: searchRegex },
    ];
  }

  const customers = await customerRepository
    .find(filter)
    .populate({
      path: "carIntakes",
      options: { sort: { createdAt: -1 } },
    })
    .skip(skip)
    .limit(limit);
  const total = await customerRepository.countDocuments(filter);

  return { customers, pagination: { page, limit, total } };
}

async function getCustomerById(id) {
  const customer = await customerRepository.findOne({
    _id: id,
    isDeleted: { $ne: true },
  });
  if (!customer) {
    throw httpError(404, { message: "Customer not found" });
  }
  return customer;
}

async function updateCustomerById(id, updateData) {
  const customer = await customerRepository.findOneAndUpdate(
    { _id: id, isDeleted: { $ne: true } },
    updateData,
    { new: true }
  );
  if (!customer) {
    throw httpError(404, { message: "Customer not found" });
  }
  return customer;
}

async function deleteCustomerById(id) {
  const customer = await customerRepository.findOneAndUpdate(
    { _id: id, isDeleted: { $ne: true } },
    { isDeleted: true, deletedAt: new Date() },
    { new: true }
  );
  if (!customer) {
    throw httpError(404, { message: "Customer not found" });
  }
}

module.exports = {
  createCustomer,
  getAllCustomers,
  getCustomerById,
  updateCustomerById,
  deleteCustomerById,
};
