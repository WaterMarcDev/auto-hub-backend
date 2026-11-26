const Customer = require("../models/Customer.model");
const { idProofError, normalizeIdProofNumber, US_ID_PROOF_PATTERNS } = require("../utils/usIdProof");

const getUsIdPattern = (type) =>
  Object.prototype.hasOwnProperty.call(US_ID_PROOF_PATTERNS, type) ? US_ID_PROOF_PATTERNS[type] : null;
const { emailError } = require("../utils/email");

// Validates a US-style phone number. Accepts 10 digits, or 11 digits with a
// leading country code 1, allowing spaces, dashes, parentheses, dots and a
// leading "+". Any value containing letters is rejected. Kept as a local
// helper (NOT a schema validator) so the shared Customer schema and all
// unrelated customer/vehicle workflows remain fully backward compatible.
const { formatUsPhone } = require("../utils/leadCapture");
const US_PHONE_ERROR = "Enter a 10-digit US phone number: (XXX) XXX-XXXX";

const isValidUsPhone = (value) => {
  if (value === undefined || value === null) return false;
  const raw = String(value).trim();
  if (!raw) return false;
  if (/[a-zA-Z]/.test(raw)) return false;
  const cleaned = raw.replace(/[\s\-().+]/g, "");
  if (!/^\d+$/.test(cleaned)) return false;
  return /^\d{10}$/.test(cleaned) || /^1\d{10}$/.test(cleaned);
};

// Longest value accepted for each customer text field. The forms use the
// same limits (maxLength), so these only stop direct API calls / pasted
// walls of text (which used to end in "request entity too large").
const CUSTOMER_FIELD_LIMITS = {
  firstName: { max: 50, label: "First name" },
  lastName: { max: 50, label: "Last name" },
  mobileNo: { max: 20, label: "Phone number" },
  email: { max: 254, label: "Email" },
  idProofType: { max: 50, label: "ID proof type" },
  idProofNumber: { max: 30, label: "ID number" },
  description: { max: 500, label: "Description" },
};
// Uploaded image references (a path / URL). Inline data:image values (the
// signature fallback when the upload returns no URL) are left to the body limit.
const MAX_IMAGE_REF_LENGTH = 2048;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Trims every text field that is present. Returns an error message for a
// value that is not text or is too long, otherwise null.
const cleanCustomerFields = (body) => {
  for (const [field, { max, label }] of Object.entries(CUSTOMER_FIELD_LIMITS)) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" && typeof value !== "number") {
      return `${label} must be text.`;
    }
    const text = String(value).trim();
    if (text.length > max) return `${label} can be at most ${max} characters.`;
    body[field] = text;
  }
  for (const field of ["idProofImage", "signatureImage"]) {
    const value = body[field];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") return "Invalid image reference.";
    if (!value.startsWith("data:image/") && value.length > MAX_IMAGE_REF_LENGTH) {
      return "Invalid image reference.";
    }
  }
  return null;
};

// The 10 digits of a US phone number ("+1 (555) 000-1234" -> "5550001234"),
// or null when it is not a 10-digit (or 1 + 10-digit) number.
const usPhoneDigits = (value) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return null;
};

// Matches a stored mobileNo holding these 10 digits in any format:
// "5550001234", "(555) 000-1234", "+1 555.000.1234" ...
const phoneMatcher = (digits) => new RegExp(`^\\D*(?:1\\D*)?${digits.split("").join("\\D*")}\\D*$`);

/**
 * Duplicate rule: one customer per person. A new customer is the same person
 * as an existing (not deleted) customer with
 *   - the same phone number (compared on its 10 digits, any formatting), or
 *   - the same ID proof type + ID number.
 * Returns { customer, field } for the first match, or null.
 *
 * The same NAME alone is not proof (two people can share a name): see
 * findSameNameCustomers — staff compare the profiles (phone, ID, signature)
 * and choose "use existing" or "create new".
 */
// Exact text match ignoring letter case and extra spaces ("  ravi   KUMAR").
const sameTextRegex = (value) => {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  return new RegExp(`^\\s*${words.map(escapeRegex).join("\\s+")}\\s*$`, "i");
};

const findDuplicateCustomer = async ({ firstName, lastName, mobileNo, idProofType, idProofNumber }, excludeId) => {
  const phone = usPhoneDigits(mobileNo);
  const idNumber = normalizeIdProofNumber(idProofNumber);
  const checks = [];
  if (phone) checks.push({ field: "mobileNo", query: { mobileNo: phoneMatcher(phone) } });
  if (idProofType && idNumber) {
    checks.push({
      field: "idProofNumber",
      query: { idProofType, idProofNumber: new RegExp(`^${escapeRegex(idNumber)}$`, "i") },
    });
  }
  for (const { field, query } of checks) {
    const filter = { ...query, isDeleted: { $ne: true } };
    if (excludeId) filter._id = { $ne: excludeId };
    const customer = await Customer.findOne(filter).sort({ createdAt: -1 }).lean();
    if (customer) return { customer, field };
  }
  return null;
};

// Existing customers with the same full name (first + last; letter case and
// extra spaces ignored), newest first, with what staff need to compare the
// profiles: phone, ID and signature.
const SAME_NAME_PROFILE_FIELDS =
  "firstName lastName mobileNo email idProofType idProofNumber idProofImage signatureImage createdAt";
const findSameNameCustomers = async ({ firstName, lastName }, excludeId) => {
  const first = String(firstName || "").trim();
  if (!first) return [];
  const last = String(lastName || "").trim();
  const filter = {
    firstName: sameTextRegex(first),
    ...(last
      ? { lastName: sameTextRegex(last) }
      : { $or: [{ lastName: { $exists: false } }, { lastName: null }, { lastName: /^\s*$/ }] }),
    isDeleted: { $ne: true },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return Customer.find(filter).select(SAME_NAME_PROFILE_FIELDS).sort({ createdAt: -1 }).limit(5).lean();
};

const duplicateMessage = ({ customer, field }) => {
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(" ") || "another customer";
  if (field === "name") {
    return `A customer named ${name} already exists${customer.mobileNo ? ` (${customer.mobileNo})` : ""}.`;
  }
  return field === "mobileNo"
    ? `A customer with this phone number already exists (${name}, ${customer.mobileNo}).`
    : `A customer with this ID number already exists (${name}, ${customer.idProofType} ${customer.idProofNumber}).`;
};

// Keys (phone / ID) of creates that are still being saved. A second request
// for the same person while the first is in flight (double click on Save)
// is turned away instead of creating a second record.
const pendingCreateKeys = new Set();

const createCustomer = async (req, res) => {
  let lockKeys = [];
  try {
    req.body = req.body || {};
    // A last name typed as only spaces is not a last name (it would be
    // trimmed away and the customer saved without one). Leaving it out is
    // fine: single-word names (waiver Full Name) have no last name.
    const rawLastName = req.body.lastName;
    if (typeof rawLastName === "string" && rawLastName.length > 0 && !rawLastName.trim()) {
      const msg = "Last name cannot be only spaces.";
      return res.status(400).json({ error: msg, message: msg });
    }
    const fieldError = cleanCustomerFields(req.body);
    if (fieldError) {
      return res.status(400).json({ error: fieldError, message: fieldError });
    }

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
      waiverDate,
    } = req.body;
    // Whitespace-only text was trimmed to "" above: store nothing for it.
    const description = req.body.description || undefined;

    if (!firstName) {
      return res.status(400).json({ error: "First name is required.", message: "First name is required." });
    }

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
    // Every customer: a mobile number, when given, must be a 10-digit US
    // number; it is stored as "(XXX) XXX-XXXX".
    const hasMobile = mobileNo !== undefined && mobileNo !== null && String(mobileNo).trim() !== "";
    if (hasMobile && !formatUsPhone(mobileNo)) {
      return res.status(400).json({ error: US_PHONE_ERROR });
    }

    // Email is optional, but when given it must be a valid address.
    const badEmail = email ? emailError(String(email)) : null;
    if (badEmail) {
      return res.status(400).json({ error: badEmail });
    }

    // Waiver customers (the only callers that send `type`): the signature is
    // required and the ID proof number must match a US ID format.
    let waiverIdNumber;
    let waiverDateValue;
    if (normalizedType) {
      if (!signatureImage || !String(signatureImage).trim()) {
        return res.status(400).json({ error: "A signature is required to save the waiver." });
      }
      // The U-Pull form requires the ID and the date.
      if (!idProofType || !String(idProofNumber || "").trim()) {
        return res.status(400).json({ error: "ID proof type and ID number are required for the waiver." });
      }
      waiverDateValue = waiverDate ? new Date(waiverDate) : new Date();
      if (Number.isNaN(waiverDateValue.getTime())) {
        return res.status(400).json({ error: "The waiver date is not a valid date." });
      }
      const idError = idProofError(idProofType, idProofNumber);
      if (idError) {
        return res.status(400).json({ error: idError });
      }
      waiverIdNumber = normalizeIdProofNumber(idProofNumber) || undefined;
    } else if (idProofType && getUsIdPattern(idProofType) && idProofNumber) {
      // Registration form with a US ID type: the number must match it too.
      const idError = idProofError(idProofType, idProofNumber);
      if (idError) {
        return res.status(400).json({ error: idError, message: idError });
      }
    }

    // One record per person (see findDuplicateCustomer). The caller gets the
    // existing customer back so it can carry on with it (the waiver opens
    // the check-in for a returning customer instead of creating a copy).
    const phoneDigits = usPhoneDigits(mobileNo);
    const idKey = idProofType && idProofNumber ? `id:${idProofType}:${normalizeIdProofNumber(idProofNumber)}` : null;
    const nameKey = String(firstName || "").trim()
      ? `name:${[firstName, lastName].map((v) => String(v || "").trim().toLowerCase().replace(/\s+/g, " ")).join("|")}`
      : null;
    const keys = [nameKey, phoneDigits && `phone:${phoneDigits}`, idKey].filter(Boolean);
    if (keys.some((k) => pendingCreateKeys.has(k))) {
      const msg = "This customer is already being saved. Please wait a moment.";
      return res.status(409).json({ error: msg, message: msg, code: "DUPLICATE_IN_PROGRESS" });
    }
    keys.forEach((k) => pendingCreateKeys.add(k));
    lockKeys = keys;

    const duplicate = await findDuplicateCustomer({ firstName, lastName, mobileNo, idProofType, idProofNumber });
    if (duplicate) {
      const msg = duplicateMessage(duplicate);
      return res.status(409).json({
        error: msg,
        message: msg,
        code: "DUPLICATE_CUSTOMER",
        duplicateField: duplicate.field,
        existingCustomer: duplicate.customer,
      });
    }

    // Same name as an existing customer: staff compare the profiles (the
    // CRM shows them side by side) and either use the existing customer or
    // confirm this is a different person by sending confirmNewCustomer: true.
    if (req.body.confirmNewCustomer !== true) {
      const sameName = await findSameNameCustomers({ firstName, lastName });
      if (sameName.length) {
        const name = [firstName, lastName].map((v) => String(v || "").trim()).filter(Boolean).join(" ");
        const msg = `A customer named ${name} already exists. Compare the profiles: use the existing customer, or confirm this is a different person.`;
        return res.status(409).json({
          error: msg,
          message: msg,
          code: "SAME_NAME_CUSTOMER",
          sameNameCustomers: sameName,
        });
      }
    }

    const newCustomer = new Customer({
      firstName,
      lastName,
      mobileNo: hasMobile ? formatUsPhone(mobileNo) : mobileNo,
      email,
      type: normalizedType,
      idProofType,
      idProofNumber: normalizedType ? waiverIdNumber : idProofNumber,
      idProofImage,
      signatureImage,
      description,
      ...(waiverDateValue ? { waiverDate: waiverDateValue } : {}),
      createdBy: req.user._id,
    });

    await newCustomer.save();
    req.app.get("io")?.emit("cache:invalidate", { scope: "customers", customer: newCustomer });
    res.status(201).json(newCustomer);
  } catch (error) {
    if (error && error.name === "ValidationError") {
      const msg = Object.values(error.errors || {})[0]?.message || error.message;
      return res.status(400).json({ error: msg, message: msg });
    }
    res.status(500).json({ message: error.message });
  } finally {
    lockKeys.forEach((k) => pendingCreateKeys.delete(k));
  }
};

// Car fields shown in the customer's "Cars" popup (VIN, make, year, model,
// trim, status) — not the whole intake record (images, documents...).
const CUSTOMER_CAR_FIELDS =
  "vin carDetails.make carDetails.model carDetails.year carDetails.trim status createdAt kyc.seller";

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

    // Search: surrounding / repeated spaces are ignored, the text is matched
    // literally (no regex injection), and a full name "John Smith" matches
    // firstName "John" + lastName "Smith". Phone digits match any formatting.
    const search = String(req.query.search || "").trim().replace(/\s+/g, " ").slice(0, 100);
    if (search) {
      const searchRegex = new RegExp(escapeRegex(search), "i");
      const or = [
        { firstName: searchRegex },
        { lastName: searchRegex },
        { email: searchRegex },
        { mobileNo: searchRegex },
      ];
      const words = search.split(" ");
      for (let i = 1; i < words.length; i += 1) {
        or.push({
          firstName: new RegExp(`${escapeRegex(words.slice(0, i).join(" "))}$`, "i"),
          lastName: new RegExp(`^${escapeRegex(words.slice(i).join(" "))}`, "i"),
        });
      }
      const digits = search.replace(/\D/g, "");
      if (digits.length >= 3 && /^[\d\s()+.-]+$/.test(search)) {
        or.push({ mobileNo: new RegExp(digits.split("").join("\\D*")) });
      }
      filter.$or = or;
    }
    const customers = await Customer.find(filter)
      .populate({
        path: "carIntakes",
        select: CUSTOMER_CAR_FIELDS,
        options: { sort: { createdAt: -1 } },
      })
      .skip(skip)
      .limit(limit)
      .lean();
    const total = await Customer.countDocuments(filter);
    res.status(200).json({ customers, pagination: { page, limit, total } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getCustomerById = async (req, res) => {
  try {
    // carIntakes = the customer's cars (Customers / Sellers list "Cars"
    // popup), newest first.
    const customer = await Customer.findOne({
      _id: req.params.id,
      isDeleted: { $ne: true },
    }).populate({
      path: "carIntakes",
      select: CUSTOMER_CAR_FIELDS,
      options: { sort: { createdAt: -1 } },
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
    req.body = req.body || {};
    // Fields the API must never change through an edit.
    for (const key of ["_id", "isDeleted", "deletedAt", "createdBy", "createdAt", "updatedAt", "__v"]) {
      delete req.body[key];
    }
    // Same text limits as create; a name cannot be changed to only spaces.
    delete req.body.confirmNewCustomer;
    const fieldError = cleanCustomerFields(req.body);
    if (fieldError) return res.status(400).json({ message: fieldError, error: fieldError });
    if (req.body.firstName === "") {
      return res.status(400).json({ message: "First name is required.", error: "First name is required." });
    }
    // A changed phone number / ID must not belong to another customer.
    if (typeof req.body.mobileNo === "string" && req.body.mobileNo.trim()) {
      const formatted = formatUsPhone(req.body.mobileNo);
      if (!formatted) return res.status(400).json({ error: US_PHONE_ERROR, message: US_PHONE_ERROR });
      req.body.mobileNo = formatted;
    }
    // (The same name is allowed: two people can share a name.)
    if (req.body.mobileNo || (req.body.idProofType && req.body.idProofNumber)) {
      const duplicate = await findDuplicateCustomer(req.body, req.params.id);
      if (duplicate) {
        const msg = duplicateMessage(duplicate);
        return res.status(409).json({ message: msg, error: msg, code: "DUPLICATE_CUSTOMER", duplicateField: duplicate.field });
      }
    }
    // A changed email must be a valid address (blank clears it).
    if (req.body && typeof req.body.email === "string" && req.body.email.trim()) {
      const badEmail = emailError(req.body.email);
      if (badEmail) return res.status(400).json({ message: badEmail, error: badEmail });
      req.body.email = req.body.email.trim();
    }
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, isDeleted: { $ne: true } },
      req.body,
      { new: true }
    );
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }
    req.app.get("io")?.emit("cache:invalidate", { scope: "customers", customer });
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
