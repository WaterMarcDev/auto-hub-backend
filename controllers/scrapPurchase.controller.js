// Scrap Material Purchase controller — fully independent.
//
// Reuses ONLY the proven print/rendering infrastructure pattern:
//   server-rendered Nunjucks template + res.render + ?autoPrint=1 iframe.
// It does NOT import or touch PaymentSlip, Invoice, CarIntake, or Transaction.

const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const ScrapPurchase = require("../models/ScrapPurchase");
const ScrapPurchaseSeller = require("../models/ScrapPurchaseSeller");

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

    // Keep the previous rule: a line needs weight or an explicit total.
    if (!(weightLbs > 0 || providedTotal > 0)) return;

    const totalAmount = providedTotal > 0 ? providedTotal : weightLbs * pricePerLb;
    const materialName =
      (it.materialName || "Scrap Material").toString().trim() || "Scrap Material";

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

    const normalizedItems = normalizeItems(items);

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
      paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
      note: note || undefined,
      taxRate: taxRate != null ? toNumber(taxRate, 0) : 0,
      createdBy: req.user ? req.user._id : undefined,
    };

    const created = await ScrapPurchase.create(payload);
    return res.status(201).json(created);
  } catch (error) {
    if (error instanceof ScrapItemValidationError) {
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
    const search = (req.query.search || "").toString().trim();

    const query = { isDeleted: { $ne: true } };
    if (search) {
      query.$or = [
        { materialName: { $regex: search, $options: "i" } },
        { note: { $regex: search, $options: "i" } },
        { "supplierSnapshot.name": { $regex: search, $options: "i" } },
        { "supplierSnapshot.phone": { $regex: search, $options: "i" } },
      ];
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

    // Only overwrite fields that were actually provided, so partial edits
    // (e.g. only the total) never wipe other values.
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
      if (supplier && mongoose.Types.ObjectId.isValid(supplier)) {
        record.supplier = supplier;
        const seller = await ScrapPurchaseSeller.findById(supplier).lean();
        record.supplierSnapshot = buildSupplierSnapshot(seller);
      } else if (supplier === null || supplier === "") {
        record.supplier = undefined;
        record.supplierSnapshot = {};
      }
    }

    // Pre-save hook recomputes totals from the (possibly overridden) values so
    // prints always reflect the latest edit.
    await record.save();

    return res.json(record);
  } catch (error) {
    if (error instanceof ScrapItemValidationError) {
      return res.status(400).json({ message: error.message });
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
    const updated = await ScrapPurchase.findByIdAndUpdate(
      id,
      { isDeleted: true, isActive: false, deletedAt: new Date() },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: "Scrap purchase not found" });
    return res.json({ message: "Scrap purchase deleted", id });
  } catch (error) {
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
