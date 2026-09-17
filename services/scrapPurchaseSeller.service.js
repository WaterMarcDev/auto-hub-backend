/**
 * Scrap Material Purchase — dedicated seller business logic. Extracted 1:1
 * from controllers/scrapPurchaseSeller.controller.js during the
 * clean-architecture migration.
 *
 * Fully independent from the Customer service and the CarIntake seller
 * controller. Only operates on the ScrapPurchaseSeller collection.
 */
const mongoose = require("mongoose");
const scrapPurchaseSellerRepository = require("../repositories/scrapPurchaseSeller.repository");

function httpError(statusCode, payload) {
  const err = new Error(payload.message || payload.error);
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

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

function assertValidId(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw httpError(400, { message: "Invalid id" });
  }
}

async function createScrapPurchaseSeller(body) {
  const name = String(body?.name || "").trim();
  const phone = String(body?.phone || "").trim();

  if (!name) {
    throw httpError(400, { error: "Seller name is required." });
  }
  if (!isValidUsPhone(phone)) {
    throw httpError(400, { error: "Please enter a valid US phone number." });
  }

  return scrapPurchaseSellerRepository.create({ name, phone });
}

async function getScrapPurchaseSellers(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 50));
  const skip = (page - 1) * limit;
  const search = (query.search || "").toString().trim();

  const mongoQuery = {};
  if (search) {
    mongoQuery.$or = [
      { name: { $regex: search, $options: "i" } },
      { phone: { $regex: search, $options: "i" } },
    ];
  }

  const [sellers, total] = await Promise.all([
    scrapPurchaseSellerRepository.find(mongoQuery).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    scrapPurchaseSellerRepository.countDocuments(mongoQuery),
  ]);

  return {
    sellers,
    pagination: {
      current: page,
      pageSize: limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

async function getScrapPurchaseSellerById(id) {
  assertValidId(id);
  const seller = await scrapPurchaseSellerRepository.findById(id).lean();
  if (!seller) throw httpError(404, { message: "Seller not found" });
  return seller;
}

async function updateScrapPurchaseSeller(id, body) {
  assertValidId(id);

  const update = {};
  if (body?.name !== undefined) {
    const name = String(body.name || "").trim();
    if (!name) {
      throw httpError(400, { error: "Seller name is required." });
    }
    update.name = name;
  }
  if (body?.phone !== undefined) {
    const phone = String(body.phone || "").trim();
    if (!isValidUsPhone(phone)) {
      throw httpError(400, { error: "Please enter a valid US phone number." });
    }
    update.phone = phone;
  }

  const seller = await scrapPurchaseSellerRepository.findByIdAndUpdate(id, update, { new: true });
  if (!seller) throw httpError(404, { message: "Seller not found" });
  return seller;
}

// This is a HARD delete, but it is deliberately scoped to this collection
// only. Historical ScrapPurchase records keep rendering their seller name and
// phone from the denormalized supplierSnapshot, so no ScrapPurchase record
// (or any other entity) is deleted or modified here.
async function deleteScrapPurchaseSeller(id) {
  assertValidId(id);
  const seller = await scrapPurchaseSellerRepository.findByIdAndDelete(id);
  if (!seller) throw httpError(404, { message: "Seller not found" });
  return seller;
}

module.exports = {
  createScrapPurchaseSeller,
  getScrapPurchaseSellers,
  getScrapPurchaseSellerById,
  updateScrapPurchaseSeller,
  deleteScrapPurchaseSeller,
};
