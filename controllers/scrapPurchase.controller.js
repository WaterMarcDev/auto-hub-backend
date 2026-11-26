// Scrap Material Purchase controller — fully independent.
//
// Reuses ONLY the proven print/rendering infrastructure pattern:
//   server-rendered Nunjucks template + res.render + ?autoPrint=1 iframe.
// It does NOT import or touch PaymentSlip, Invoice, CarIntake, or Transaction.

const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const ScrapPurchase = require("../models/ScrapPurchase.model");
const ScrapPurchaseSeller = require("../models/ScrapPurchaseSeller.model");
// Purchased scrap material is added to Element Hub stock (see that service).
const scrapPurchaseElementHub = require("../services/scrapPurchaseElementHub.service");
const { ElementHubStockError } = scrapPurchaseElementHub;
const { containsRegex, phoneDigitsRegex } = require("../utils/searchRegex");

// ─── helpers ────────────────────────────────────────────────────────────────

const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

// Build a stable supplier snapshot for the bill so printing is not dependent on
// the live seller record. The dedicated ScrapPurchaseSeller stores only a
// verbatim `name` and `phone`, so the snapshot mirrors those exactly.
const buildSupplierSnapshot = (seller) => {
  if (!seller) return {};
  return {
    id: String(seller._id || ""),
    name: (seller.name || "").toString().trim(),
    phone: seller.phone || "",
  };
};

// Raised for malformed item input so the routes can answer with HTTP 400
// instead of silently coercing bad values (e.g. "abc" -> 0) or failing with 500.
class ScrapItemValidationError extends Error {}

// Input limits (mirrored in src/pages/ScrapPurchase/index.jsx). Weight and
// price take at most 2 decimals; totals are rounded to cents.
const LIMITS = {
  MAX_WEIGHT_LBS: 200000,
  MAX_PRICE_PER_LB: 2000,
  MAX_TOTAL: 10000000,
  MAX_ITEMS: 50,
  MAX_MATERIAL_NAME: 100,
  MAX_DESCRIPTION: 500,
  MAX_NOTE: 50,
  MAX_PAYMENT_METHOD: 50,
};

const fmtLimit = (n) => Number(n).toLocaleString("en-US");

// True when n has at most 2 digits after the decimal point.
const hasAtMost2Decimals = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

const checkWeight = (n) => {
  if (n > LIMITS.MAX_WEIGHT_LBS) {
    throw new ScrapItemValidationError(
      `Weight cannot be more than ${fmtLimit(LIMITS.MAX_WEIGHT_LBS)} lb`
    );
  }
  if (!hasAtMost2Decimals(n)) {
    throw new ScrapItemValidationError("Weight can have at most 2 decimal places");
  }
};

const checkPrice = (n) => {
  if (n > LIMITS.MAX_PRICE_PER_LB) {
    throw new ScrapItemValidationError(
      `Price per lb cannot be more than $${fmtLimit(LIMITS.MAX_PRICE_PER_LB)}`
    );
  }
  if (!hasAtMost2Decimals(n)) {
    throw new ScrapItemValidationError("Price per lb can have at most 2 decimal places");
  }
};

const checkTotal = (n, label = "Total amount") => {
  if (n > LIMITS.MAX_TOTAL) {
    throw new ScrapItemValidationError(
      `${label} cannot be more than $${fmtLimit(LIMITS.MAX_TOTAL)}`
    );
  }
};

// Optional text field: undefined/null pass through; otherwise must be a string
// no longer than `max` (after trim).
const checkText = (value, max, label) => {
  if (value === undefined || value === null) return value;
  if (typeof value === "object") {
    throw new ScrapItemValidationError(`${label} must be text`);
  }
  const text = String(value).trim();
  if (text.length > max) {
    throw new ScrapItemValidationError(`${label} can be at most ${max} characters`);
  }
  return text;
};

// Validate the top-level numeric/text fields of a create/update body. Only
// fields that are present are checked (partial updates stay possible).
const validateTopLevel = ({ weightLbs, pricePerLb, totalAmount, taxRate, note, paymentMethod, materialName }) => {
  if (weightLbs !== undefined) {
    const n = requireNumber(weightLbs, "Weight (lbs)");
    if (n < 0) throw new ScrapItemValidationError("Weight cannot be negative");
    checkWeight(n);
  }
  if (pricePerLb !== undefined) {
    const n = requireNumber(pricePerLb, "Price per lb");
    if (n < 0) throw new ScrapItemValidationError("Price per lb cannot be negative");
    checkPrice(n);
  }
  if (totalAmount !== undefined) {
    const n = requireNumber(totalAmount, "Total amount");
    if (n < 0) throw new ScrapItemValidationError("Total cannot be negative");
    checkTotal(n);
  }
  if (taxRate !== undefined && taxRate !== null) {
    const n = requireNumber(taxRate, "Tax rate");
    if (n < 0 || n > 1) throw new ScrapItemValidationError("Tax rate must be between 0 and 1");
  }
  checkText(note, LIMITS.MAX_NOTE, "Note");
  checkText(paymentMethod, LIMITS.MAX_PAYMENT_METHOD, "Payment method");
  checkText(materialName, LIMITS.MAX_MATERIAL_NAME, "Material name");
};

// Payment date must be a valid date and not in the future: its calendar day in
// New Jersey time may be today or earlier (the date picker itself also blocks
// every future day).
const parsePaymentDate = (value) => {
  if (isBlankInput(value)) return null;
  if (typeof value === "boolean" || (typeof value === "object" && !(value instanceof Date))) {
    throw new ScrapItemValidationError("Payment date must be a valid date");
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ScrapItemValidationError("Payment date must be a valid date");
  }
  // Compared as calendar days in the yard's time zone (New Jersey), so
  // "today" is accepted at any hour and tomorrow is always refused.
  if (paymentDay(d) > paymentDay(new Date())) {
    throw new ScrapItemValidationError("Payment date cannot be in the future");
  }
  return d;
};

// YYYY-MM-DD of a date in America/New_York.
function paymentDay(date) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch (e) {
    return date.toISOString().slice(0, 10);
  }
}


const isBlankInput = (v) =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "");

// Strict numeric parse for line fields. Blank -> 0; anything that is not a real
// finite number (including booleans, arrays and objects) is rejected.
const requireNumber = (value, field) => {
  if (isBlankInput(value)) return 0;
  if (typeof value === "boolean" || typeof value === "object") {
    throw new ScrapItemValidationError(`${field} must be a valid number`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ScrapItemValidationError(`${field} must be a valid number`);
  }
  return n;
};

// Normalize an incoming items[] array from the client.
// - Blank rows are dropped (preserves the previous behavior).
// - Invalid values (negative / non-numeric / NaN / Infinity / objects / arrays)
//   throw ScrapItemValidationError so the caller can return HTTP 400.
// - Duplicate material names are rejected; each material appears at most once.
const normalizeItems = (items) => {
  if (!Array.isArray(items)) return [];
  if (items.length > LIMITS.MAX_ITEMS) {
    throw new ScrapItemValidationError(
      `A purchase can have at most ${LIMITS.MAX_ITEMS} material lines`
    );
  }

  const out = [];
  const seen = new Set();

  items.forEach((it) => {
    if (!it || typeof it !== "object") {
      throw new ScrapItemValidationError("Each item must be an object");
    }

    const rawWeight = it.weightLbs;
    const rawPrice = it.pricePerLb;
    const rawTotal = it.totalAmount;

    // Fully blank row => ignore (matches prior filter behavior).
    if (isBlankInput(rawWeight) && isBlankInput(rawPrice) && isBlankInput(rawTotal)) {
      return;
    }

    const weightLbs = requireNumber(rawWeight, "Weight (lbs)");
    const pricePerLb = requireNumber(rawPrice, "Price per lb");
    const providedTotal = requireNumber(rawTotal, "Line total");

    if (weightLbs < 0) throw new ScrapItemValidationError("Weight cannot be negative");
    if (pricePerLb < 0) throw new ScrapItemValidationError("Price per lb cannot be negative");
    if (providedTotal < 0) throw new ScrapItemValidationError("Line total cannot be negative");
    checkWeight(weightLbs);
    checkPrice(pricePerLb);

    // Keep the previous rule: a line needs weight or an explicit total.
    if (!(weightLbs > 0 || providedTotal > 0)) return;

    const totalAmount = providedTotal > 0 ? providedTotal : weightLbs * pricePerLb;
    checkTotal(totalAmount, "Line total");
    const materialName =
      checkText(it.materialName, LIMITS.MAX_MATERIAL_NAME, "Material name") || "Scrap Material";
    const description = checkText(it.description, LIMITS.MAX_DESCRIPTION, "Item description") || "";

    const key = materialName.toLowerCase();
    if (seen.has(key)) {
      throw new ScrapItemValidationError(`Duplicate material: ${materialName}`);
    }
    seen.add(key);

    out.push({
      materialName,
      description,
      weightLbs,
      pricePerLb,
      totalAmount: round2(totalAmount),
    });
  });

  return out;
};

// ─── create ─────────────────────────────────────────────────────────────────

// @desc   Create a scrap material purchase
// @route  POST /api/scrap-purchase
// @access Private (auth)
const createScrapPurchase = async (req, res) => {
  try {
    const {
      materialName,
      weightLbs,
      pricePerLb,
      totalAmount,
      items,
      supplier,
      paymentMethod,
      paymentDate,
      note,
      taxRate,
    } = req.body || {};

    validateTopLevel({ weightLbs, pricePerLb, totalAmount, taxRate, note, paymentMethod, materialName });
    const parsedPaymentDate = parsePaymentDate(paymentDate);
    const normalizedItems = normalizeItems(items);
    checkTotal(
      normalizedItems.reduce((acc, it) => acc + Number(it.totalAmount || 0), 0),
      "Grand total"
    );

    // Basic validation: need either a weighted single material or item lines.
    const hasWeight = toNumber(weightLbs, 0) > 0;
    const hasTotal = toNumber(totalAmount, 0) > 0;
    if (!normalizedItems.length && !hasWeight && !hasTotal) {
      return res.status(400).json({
        message:
          "Provide a weight (lbs), a total amount, or at least one item line",
      });
    }

    // Read-only lookup of the supplier (dedicated ScrapPurchaseSeller collection).
    let supplierSnapshot = {};
    if (supplier && mongoose.Types.ObjectId.isValid(supplier)) {
      const seller = await ScrapPurchaseSeller.findById(supplier).lean();
      supplierSnapshot = buildSupplierSnapshot(seller);
    }

    const payload = {
      materialName: (materialName || "Scrap Material").toString().trim(),
      weightLbs: toNumber(weightLbs, 0),
      pricePerLb: toNumber(pricePerLb, 0),
      totalAmount: toNumber(totalAmount, 0),
      items: normalizedItems,
      supplier: supplier && mongoose.Types.ObjectId.isValid(supplier) ? supplier : undefined,
      supplierSnapshot,
      paymentMethod: paymentMethod || undefined,
      paymentDate: parsedPaymentDate || new Date(),
      note: note || undefined,
      taxRate: taxRate != null ? toNumber(taxRate, 0) : 0,
      createdBy: req.user ? req.user._id : undefined,
    };

    const created = await ScrapPurchase.create(payload);

    // Add the purchased materials to Element Hub stock. Never blocks the
    // purchase: a hub failure is returned as elementHubError instead.
    const hub = await scrapPurchaseElementHub.postCreatedPurchase(
      created,
      req.user ? req.user._id : undefined
    );
    return res.status(201).json({ ...created.toObject(), ...hub });
  } catch (error) {
    if (error instanceof ScrapItemValidationError) {
      return res.status(400).json({ message: error.message });
    }
    if (error instanceof mongoose.Error.ValidationError) {
      return res.status(400).json({ message: error.message });
    }
    console.error("Error creating scrap purchase:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// ─── list ───────────────────────────────────────────────────────────────────

// @desc   List scrap purchases (paginated + optional search)
// @route  GET /api/scrap-purchase
// @access Private (auth)
const getScrapPurchases = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const skip = (page - 1) * limit;
    // Trimmed, regex-escaped search; whitespace matches any whitespace so a
    // full seller name ("John  Smith") is found; digits match any phone format.
    const searchRegex = containsRegex(req.query.search);

    const query = { isDeleted: { $ne: true } };
    if (searchRegex) {
      query.$or = [
        { materialName: searchRegex },
        { "items.materialName": searchRegex },
        { note: searchRegex },
        { "supplierSnapshot.name": searchRegex },
        { "supplierSnapshot.phone": searchRegex },
      ];
      const phoneRegex = phoneDigitsRegex(req.query.search);
      if (phoneRegex) query.$or.push({ "supplierSnapshot.phone": phoneRegex });
    }

    const [records, total] = await Promise.all([
      ScrapPurchase.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("supplier", "name phone")
        .lean(),
      ScrapPurchase.countDocuments(query),
    ]);

    return res.json({
      records,
      purchases: records, // alias for convenience
      pagination: {
        current: page,
        pageSize: limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (error) {
    console.error("Error listing scrap purchases:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// ─── get one ────────────────────────────────────────────────────────────────

// @desc   Get a single scrap purchase
// @route  GET /api/scrap-purchase/:id
// @access Private (auth)
const getScrapPurchaseById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const record = await ScrapPurchase.findOne({
      _id: id,
      isDeleted: { $ne: true },
    })
      .populate("supplier", "name phone")
      .lean();

    if (!record) return res.status(404).json({ message: "Scrap purchase not found" });
    return res.json(record);
  } catch (error) {
    console.error("Error fetching scrap purchase:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// ─── update (editable pre-print bill) ───────────────────────────────────────

// @desc   Update a scrap purchase / edit its bill line items before printing
// @route  PUT /api/scrap-purchase/:id
// @access Private (auth)
const updateScrapPurchase = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }

    const record = await ScrapPurchase.findOne({
      _id: id,
      isDeleted: { $ne: true },
    });
    if (!record) return res.status(404).json({ message: "Scrap purchase not found" });

    const {
      materialName,
      weightLbs,
      pricePerLb,
      totalAmount,
      items,
      supplier,
      paymentMethod,
      paymentDate,
      note,
      taxRate,
    } = req.body || {};

    validateTopLevel({ weightLbs, pricePerLb, totalAmount, taxRate, note, paymentMethod, materialName });
    const normalizedItems = items !== undefined ? normalizeItems(items) : undefined;
    if (normalizedItems) {
      checkTotal(
        normalizedItems.reduce((acc, it) => acc + Number(it.totalAmount || 0), 0),
        "Grand total"
      );
    }

    // Only overwrite fields that were actually provided, so partial edits
    // (e.g. only the total) never wipe other values.
    if (materialName !== undefined) {
      record.materialName = (materialName || "Scrap Material").toString().trim();
    }
    if (weightLbs !== undefined) record.weightLbs = toNumber(weightLbs, 0);
    if (pricePerLb !== undefined) record.pricePerLb = toNumber(pricePerLb, 0);
    if (totalAmount !== undefined) record.totalAmount = toNumber(totalAmount, 0);
    if (normalizedItems !== undefined) record.items = normalizedItems;
    if (paymentMethod !== undefined) record.paymentMethod = paymentMethod;
    if (paymentDate !== undefined) {
      // A legacy record that already carries a future date can still be
      // edited as long as that date is sent back unchanged.
      const unchanged =
        record.paymentDate &&
        !isBlankInput(paymentDate) &&
        new Date(paymentDate).getTime() === new Date(record.paymentDate).getTime();
      if (!unchanged) {
        const parsed = parsePaymentDate(paymentDate);
        record.paymentDate = parsed || record.paymentDate;
      }
    }
    if (note !== undefined) record.note = note === null ? note : String(note).trim();
    if (taxRate !== undefined) record.taxRate = toNumber(taxRate, 0);

    if (supplier !== undefined) {
      if (supplier && mongoose.Types.ObjectId.isValid(supplier)) {
        record.supplier = supplier;
        const seller = await ScrapPurchaseSeller.findById(supplier).lean();
        record.supplierSnapshot = buildSupplierSnapshot(seller);
      } else if (supplier === null || supplier === "") {
        record.supplier = undefined;
        record.supplierSnapshot = {};
      }
    }

    // Move Element Hub stock to match the edited lines (only the difference).
    // Null for purchases created before the Element Hub integration.
    const hubChange = await scrapPurchaseElementHub.prepareEdit(
      record,
      req.user ? req.user._id : undefined
    );

    // Pre-save hook recomputes totals from the (possibly overridden) values so
    // prints always reflect the latest edit.
    try {
      await record.save();
    } catch (saveErr) {
      if (hubChange) await hubChange.rollback();
      throw saveErr;
    }
    if (hubChange) await hubChange.commitHistory();

    return res.json(record);
  } catch (error) {
    if (error instanceof ScrapItemValidationError) {
      return res.status(400).json({ message: error.message });
    }
    if (error instanceof mongoose.Error.ValidationError) {
      return res.status(400).json({ message: error.message });
    }
    if (error instanceof ElementHubStockError) {
      return res.status(409).json({ message: error.message });
    }
    if (error instanceof mongoose.Error.VersionError) {
      return res.status(409).json({
        message: "This purchase was changed by someone else. Reload it and try again.",
      });
    }
    console.error("Error updating scrap purchase:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// ─── soft delete ────────────────────────────────────────────────────────────

// @desc   Soft-delete a scrap purchase
// @route  DELETE /api/scrap-purchase/:id
// @access Private (auth)
const deleteScrapPurchase = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }

    // A purchase that added Element Hub stock takes it back out first. If
    // that stock was already sold, the delete is refused (409).
    const existing = await ScrapPurchase.findById(id);
    const hubChange = existing
      ? await scrapPurchaseElementHub.prepareDelete(existing, req.user ? req.user._id : undefined)
      : null;
    if (hubChange) {
      const now = new Date();
      let deleted = null;
      try {
        deleted = await ScrapPurchase.findOneAndUpdate(
          { _id: id, isDeleted: { $ne: true }, __v: existing.__v },
          {
            $set: {
              isDeleted: true,
              isActive: false,
              deletedAt: now,
              elementHubPosted: [],
              elementHubPostedAt: now,
            },
            $inc: { __v: 1 },
          },
          { new: true }
        );
      } catch (deleteErr) {
        await hubChange.rollback();
        throw deleteErr;
      }
      if (!deleted) {
        await hubChange.rollback();
        return res.status(409).json({
          message: "This purchase was changed by someone else. Reload it and try again.",
        });
      }
      await hubChange.commitHistory();
      return res.json({ message: "Scrap purchase deleted", id });
    }

    const updated = await ScrapPurchase.findByIdAndUpdate(
      id,
      { isDeleted: true, isActive: false, deletedAt: new Date() },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: "Scrap purchase not found" });
    return res.json({ message: "Scrap purchase deleted", id });
  } catch (error) {
    if (error instanceof ElementHubStockError) {
      return res.status(409).json({ message: error.message });
    }
    console.error("Error deleting scrap purchase:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// ─── print ──────────────────────────────────────────────────────────────────

// @desc   Render the scrap purchase bill (HTML, printable; ?autoPrint=1 triggers
//         the browser print dialog via the same proven pattern used elsewhere)
// @route  GET /api/scrap-purchase/:id/print
// @access Private (auth)
const printScrapPurchase = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).send("Invalid id");
    }

    // Always read the CURRENT persisted values so a print reflects the latest
    // edits — this is what prevents stale-state prints.
    const record = await ScrapPurchase.findOne({
      _id: id,
      isDeleted: { $ne: true },
    })
      .populate("supplier", "name phone")
      .populate("createdBy", "first_name last_name email")
      .lean();

    if (!record) return res.status(404).send("Scrap purchase not found");

    // Build the bill lines. Prefer explicit items[]; otherwise fall back to the
    // single top-level material.
    let items = [];
    if (Array.isArray(record.items) && record.items.length) {
      items = record.items.map((it) => ({
        name: it.materialName,
        description: it.description,
        quantity: `${it.weightLbs || 0} lb`,
        price: it.pricePerLb || 0,
        lineTotal: it.totalAmount || 0,
      }));
    } else {
      // Legacy/fallback single-material record. Quantity and rate are already
      // shown in their own table columns, so do NOT manufacture a description
      // containing them (previously rendered as "50 lb @ 2/lb").
      items = [
        {
          name: record.materialName || "Scrap Material",
          description: "",
          quantity: `${record.weightLbs || 0} lb`,
          price: record.pricePerLb || 0,
          lineTotal: record.totalAmount || 0,
        },
      ];
    }

    // Load the logo as a base64 data URI (same approach as existing print paths).
    let logoDataUri = null;
    try {
      const logoPath = path.join(__dirname, "..", "assets", "logo-sm1.png");
      if (fs.existsSync(logoPath)) {
        const buf = fs.readFileSync(logoPath);
        logoDataUri = `data:image/png;base64,${buf.toString("base64")}`;
      }
    } catch (e) {
      console.warn("Could not read logo for scrap purchase bill:", e && e.message);
      logoDataUri = null;
    }

    const billPadded = record.billNumber
      ? String(record.billNumber).padStart(7, "0")
      : null;

    const supplier =
      record.supplier || record.supplierSnapshot || null;

    return res.render("scrapPurchaseBill.njk", {
      record,
      items,
      supplier,
      billPadded,
      billPrefix: record.billPrefix || "SP",
      totalAmount: round2(record.totalAmount || 0),
      taxRate: record.taxRate || 0,
      taxAmount: round2(record.taxAmount || 0),
      generatedAt: new Date(),
      generatedBy: req.user
        ? { id: req.user._id, name: req.user.first_name || req.user.name || "" }
        : null,
      logoSrc: logoDataUri || "/assets/logo-sm1.png",
    });
  } catch (error) {
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
