/**
 * Scrap Material Purchase business logic. Extracted 1:1 from
 * controllers/scrapPurchase.controller.js during the clean-architecture
 * migration — every validation rule (ScrapItemValidationError cases),
 * numeric coercion, and the print-bill data assembly are preserved exactly.
 *
 * Fully independent, as documented in the original file: does NOT touch
 * PaymentSlip, Invoice, CarIntake, or Transaction.
 */
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const scrapPurchaseRepository = require("../repositories/scrapPurchase.repository");
const scrapPurchaseSellerRepository = require("../repositories/scrapPurchaseSeller.repository");

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

const isBlankInput = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

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

  const out = [];
  const seen = new Set();

  items.forEach((it) => {
    if (!it || typeof it !== "object") {
      throw new ScrapItemValidationError("Each item must be an object");
    }

    const rawWeight = it.weightLbs;
    const rawPrice = it.pricePerLb;
    const rawTotal = it.totalAmount;

    if (isBlankInput(rawWeight) && isBlankInput(rawPrice) && isBlankInput(rawTotal)) {
      return;
    }

    const weightLbs = requireNumber(rawWeight, "Weight (lbs)");
    const pricePerLb = requireNumber(rawPrice, "Price per lb");
    const providedTotal = requireNumber(rawTotal, "Line total");

    if (weightLbs < 0) throw new ScrapItemValidationError("Weight cannot be negative");
    if (pricePerLb < 0) throw new ScrapItemValidationError("Price per lb cannot be negative");
    if (providedTotal < 0) throw new ScrapItemValidationError("Line total cannot be negative");

    if (!(weightLbs > 0 || providedTotal > 0)) return;

    const totalAmount = providedTotal > 0 ? providedTotal : weightLbs * pricePerLb;
    const materialName = (it.materialName || "Scrap Material").toString().trim() || "Scrap Material";

    const key = materialName.toLowerCase();
    if (seen.has(key)) {
      throw new ScrapItemValidationError(`Duplicate material: ${materialName}`);
    }
    seen.add(key);

    out.push({
      materialName,
      description: (it.description || "").toString().trim(),
      weightLbs,
      pricePerLb,
      totalAmount: round2(totalAmount),
    });
  });

  return out;
};

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

async function createScrapPurchase(body, userId) {
  const { materialName, weightLbs, pricePerLb, totalAmount, items, supplier, paymentMethod, paymentDate, note, taxRate } = body || {};

  const normalizedItems = normalizeItems(items);

  const hasWeight = toNumber(weightLbs, 0) > 0;
  const hasTotal = toNumber(totalAmount, 0) > 0;
  if (!normalizedItems.length && !hasWeight && !hasTotal) {
    throw badRequestError("Provide a weight (lbs), a total amount, or at least one item line");
  }

  let supplierSnapshot = {};
  if (supplier && isValidObjectId(supplier)) {
    const seller = await scrapPurchaseSellerRepository.findById(supplier).lean();
    supplierSnapshot = buildSupplierSnapshot(seller);
  }

  const payload = {
    materialName: (materialName || "Scrap Material").toString().trim(),
    weightLbs: toNumber(weightLbs, 0),
    pricePerLb: toNumber(pricePerLb, 0),
    totalAmount: toNumber(totalAmount, 0),
    items: normalizedItems,
    supplier: supplier && isValidObjectId(supplier) ? supplier : undefined,
    supplierSnapshot,
    paymentMethod: paymentMethod || undefined,
    paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
    note: note || undefined,
    taxRate: taxRate != null ? toNumber(taxRate, 0) : 0,
    createdBy: userId || undefined,
  };

  return scrapPurchaseRepository.create(payload);
}

async function getScrapPurchases(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 10));
  const skip = (page - 1) * limit;
  const search = (query.search || "").toString().trim();

  const filter = { isDeleted: { $ne: true } };
  if (search) {
    filter.$or = [
      { materialName: { $regex: search, $options: "i" } },
      { note: { $regex: search, $options: "i" } },
      { "supplierSnapshot.name": { $regex: search, $options: "i" } },
      { "supplierSnapshot.phone": { $regex: search, $options: "i" } },
    ];
  }

  const [records, total] = await Promise.all([
    scrapPurchaseRepository.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("supplier", "name phone").lean(),
    scrapPurchaseRepository.countDocuments(filter),
  ]);

  return {
    records,
    purchases: records, // alias for convenience
    pagination: { current: page, pageSize: limit, total, totalPages: Math.ceil(total / limit) || 1 },
  };
}

async function getScrapPurchaseById(id) {
  if (!isValidObjectId(id)) {
    throw badRequestError("Invalid id");
  }
  const record = await scrapPurchaseRepository.findOne({ _id: id, isDeleted: { $ne: true } }).populate("supplier", "name phone").lean();

  if (!record) throw notFoundError("Scrap purchase not found");
  return record;
}

async function updateScrapPurchase(id, body) {
  if (!isValidObjectId(id)) {
    throw badRequestError("Invalid id");
  }

  const record = await scrapPurchaseRepository.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!record) throw notFoundError("Scrap purchase not found");

  const { materialName, weightLbs, pricePerLb, totalAmount, items, supplier, paymentMethod, paymentDate, note, taxRate } = body || {};

  if (materialName !== undefined) {
    record.materialName = (materialName || "Scrap Material").toString().trim();
  }
  if (weightLbs !== undefined) record.weightLbs = toNumber(weightLbs, 0);
  if (pricePerLb !== undefined) record.pricePerLb = toNumber(pricePerLb, 0);
  if (totalAmount !== undefined) record.totalAmount = toNumber(totalAmount, 0);
  if (items !== undefined) record.items = normalizeItems(items);
  if (paymentMethod !== undefined) record.paymentMethod = paymentMethod;
  if (paymentDate !== undefined) {
    record.paymentDate = paymentDate ? new Date(paymentDate) : record.paymentDate;
  }
  if (note !== undefined) record.note = note;
  if (taxRate !== undefined) record.taxRate = toNumber(taxRate, 0);

  if (supplier !== undefined) {
    if (supplier && isValidObjectId(supplier)) {
      record.supplier = supplier;
      const seller = await scrapPurchaseSellerRepository.findById(supplier).lean();
      record.supplierSnapshot = buildSupplierSnapshot(seller);
    } else if (supplier === null || supplier === "") {
      record.supplier = undefined;
      record.supplierSnapshot = {};
    }
  }

  // Pre-save hook recomputes totals from the (possibly overridden) values so
  // prints always reflect the latest edit.
  await scrapPurchaseRepository.save(record);

  return record;
}

async function deleteScrapPurchase(id) {
  if (!isValidObjectId(id)) {
    throw badRequestError("Invalid id");
  }
  const updated = await scrapPurchaseRepository.findByIdAndUpdate(id, { isDeleted: true, isActive: false, deletedAt: new Date() }, { new: true });
  if (!updated) throw notFoundError("Scrap purchase not found");
}

function plainTextError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.plainText = true;
  return err;
}

async function buildPrintScrapPurchaseData(id, reqUser) {
  if (!isValidObjectId(id)) {
    throw plainTextError(400, "Invalid id");
  }

  // Always read the CURRENT persisted values so a print reflects the latest
  // edits — this is what prevents stale-state prints.
  const record = await scrapPurchaseRepository
    .findOne({ _id: id, isDeleted: { $ne: true } })
    .populate("supplier", "name phone")
    .populate("createdBy", "first_name last_name email")
    .lean();

  if (!record) throw plainTextError(404, "Scrap purchase not found");

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

  const billPadded = record.billNumber ? String(record.billNumber).padStart(7, "0") : null;
  const supplier = record.supplier || record.supplierSnapshot || null;

  return {
    record,
    items,
    supplier,
    billPadded,
    billPrefix: record.billPrefix || "SP",
    totalAmount: round2(record.totalAmount || 0),
    taxRate: record.taxRate || 0,
    taxAmount: round2(record.taxAmount || 0),
    generatedAt: new Date(),
    generatedBy: reqUser ? { id: reqUser._id, name: reqUser.first_name || reqUser.name || "" } : null,
    logoSrc: logoDataUri || "/assets/logo-sm1.png",
  };
}

module.exports = {
  ScrapItemValidationError,
  createScrapPurchase,
  getScrapPurchases,
  getScrapPurchaseById,
  updateScrapPurchase,
  deleteScrapPurchase,
  buildPrintScrapPurchaseData,
};
