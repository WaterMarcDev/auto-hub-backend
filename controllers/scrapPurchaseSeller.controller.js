// Scrap Material Purchase — dedicated seller controller.
//
// Fully independent from the Customer controller and the CarIntake seller
// controller. Only operates on the ScrapPurchaseSeller collection.
//
//   - create       : validates a US phone, stores { name, phone } verbatim
//   - list/search  : by name or phone, paginated
//   - getById      : single seller
//   - update       : name / phone
//   - delete       : HARD delete from ScrapPurchaseSeller ONLY. It never
//                    touches ScrapPurchase, supplierSnapshot, Customer,
//                    CarIntake, Invoice, PaymentSlip, Transaction or Inventory.

const mongoose = require("mongoose");
const ScrapPurchaseSeller = require("../models/ScrapPurchaseSeller.model");

// US phone validation (mirrors the frontend helper). Accepts 10 digits, or 11
// digits with a leading country code 1, allowing spaces, dashes, parentheses
// and a leading "+". Rejects any value containing letters.
const isValidUsPhone = (value) => {
  if (value === undefined || value === null) return false;
  const raw = String(value).trim();
  if (!raw) return false;
  if (/[a-zA-Z]/.test(raw)) return false;
  const cleaned = raw.replace(/[\s\-().+]/g, "");
  if (!/^\d+$/.test(cleaned)) return false;
  return /^\d{10}$/.test(cleaned) || /^1\d{10}$/.test(cleaned);
};

// ─── create ─────────────────────────────────────────────────────────────────

// @desc   Create a scrap purchase seller
// @route  POST /api/scrap-purchase-sellers
// @access Private (auth)
const createScrapPurchaseSeller = async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const phone = String(req.body?.phone || "").trim();

    if (!name) {
      return res.status(400).json({ error: "Seller name is required." });
    }
    if (!isValidUsPhone(phone)) {
      return res.status(400).json({ error: "Please enter a valid US phone number." });
    }

    const seller = await ScrapPurchaseSeller.create({ name, phone });
    return res.status(201).json(seller);
  } catch (error) {
    console.error("Error creating scrap purchase seller:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// ─── list / search ──────────────────────────────────────────────────────────

// @desc   List scrap purchase sellers (paginated + optional search)
// @route  GET /api/scrap-purchase-sellers
// @access Private (auth)
const getScrapPurchaseSellers = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;
    const search = (req.query.search || "").toString().trim();

    const query = {};
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ];
    }

    const [sellers, total] = await Promise.all([
      ScrapPurchaseSeller.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ScrapPurchaseSeller.countDocuments(query),
    ]);

    return res.json({
      sellers,
      pagination: {
        current: page,
        pageSize: limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (error) {
    console.error("Error listing scrap purchase sellers:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// ─── get one ────────────────────────────────────────────────────────────────

// @desc   Get a single scrap purchase seller
// @route  GET /api/scrap-purchase-sellers/:id
// @access Private (auth)
const getScrapPurchaseSellerById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const seller = await ScrapPurchaseSeller.findById(id).lean();
    if (!seller) return res.status(404).json({ message: "Seller not found" });
    return res.json(seller);
  } catch (error) {
    console.error("Error fetching scrap purchase seller:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// ─── update ─────────────────────────────────────────────────────────────────

// @desc   Update a scrap purchase seller
// @route  PUT /api/scrap-purchase-sellers/:id
// @access Private (auth)
const updateScrapPurchaseSeller = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }

    const update = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || "").trim();
      if (!name) {
        return res.status(400).json({ error: "Seller name is required." });
      }
      update.name = name;
    }
    if (req.body?.phone !== undefined) {
      const phone = String(req.body.phone || "").trim();
      if (!isValidUsPhone(phone)) {
        return res.status(400).json({ error: "Please enter a valid US phone number." });
      }
      update.phone = phone;
    }

    const seller = await ScrapPurchaseSeller.findByIdAndUpdate(id, update, {
      new: true,
    });
    if (!seller) return res.status(404).json({ message: "Seller not found" });
    return res.json(seller);
  } catch (error) {
    console.error("Error updating scrap purchase seller:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// ─── hard delete ────────────────────────────────────────────────────────────

// @desc   Permanently delete a scrap purchase seller
// @route  DELETE /api/scrap-purchase-sellers/:id
// @access Private (auth)
//
// This is a HARD delete, but it is deliberately scoped to this collection
// only. Historical ScrapPurchase records keep rendering their seller name and
// phone from the denormalized supplierSnapshot, so no ScrapPurchase record
// (or any other entity) is deleted or modified here.
const deleteScrapPurchaseSeller = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const seller = await ScrapPurchaseSeller.findByIdAndDelete(id);
    if (!seller) return res.status(404).json({ message: "Seller not found" });
    return res.json({ message: "Seller permanently deleted", seller });
  } catch (error) {
    console.error("Error deleting scrap purchase seller:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  createScrapPurchaseSeller,
  getScrapPurchaseSellers,
  getScrapPurchaseSellerById,
  updateScrapPurchaseSeller,
  deleteScrapPurchaseSeller,
};
