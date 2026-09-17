/**
 * Seller business logic. Extracted 1:1 from controllers/sellerController.js
 * during the clean-architecture migration — every rule, message, status
 * code, and populate/select shape below is intentionally unchanged.
 *
 * PRESERVED BUG (not fixed, per migration scope): deleteSeller() and
 * getSellerCarIntakes() require("../models/CarIntake"), but no such file
 * exists — the real model file is models/carInTake.model.js. In the
 * original controller this threw "Cannot find module" at runtime for both
 * endpoints. That exact behavior is preserved here rather than silently
 * "fixed" to require("../repositories/carIntake.repository") — this
 * migration's scope is structural only.
 */
const sellerRepository = require("../repositories/seller.repository");

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function createSeller({ body, createdBy }) {
  const existingSeller = await sellerRepository.findOne({
    $or: [{ email: body.email }, { mobileNo: body.mobileNo }],
    isActive: true,
  });

  if (existingSeller) {
    throw badRequestError("Seller already exists with this email or mobile number");
  }

  const seller = new (sellerRepository.raw())({
    ...body,
    createdBy,
  });

  await sellerRepository.save(seller);
  return seller;
}

async function getSellers({ page = 1, limit = 10, search } = {}) {
  const skip = (page - 1) * limit;

  const filter = { isActive: true };
  if (search) {
    const searchRegex = new RegExp(search, "i");
    filter.$or = [
      { firstName: searchRegex },
      { lastName: searchRegex },
      { email: searchRegex },
      { mobileNo: searchRegex },
    ];
  }

  const sellers = await sellerRepository
    .find(filter)
    .populate("createdBy", "first_name last_name email")
    .populate("updatedBy", "first_name last_name email")
    .populate({
      path: "carIntakes",
      options: { sort: { createdAt: -1 } },
    })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const total = await sellerRepository.countDocuments(filter);

  return {
    sellers,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

async function getSeller(id) {
  const seller = await sellerRepository
    .findById(id)
    .populate("createdBy", "first_name last_name email")
    .populate("updatedBy", "first_name last_name email")
    .populate({
      path: "carIntakes",
      select: "vin carDetails price.finalPrice status createdAt",
      options: { sort: { createdAt: -1 } },
    });

  if (!seller || !seller.isActive) {
    throw notFoundError("Seller not found");
  }

  return seller;
}

async function updateSeller(id, body, updatedBy) {
  const seller = await sellerRepository.findById(id);
  if (!seller || !seller.isActive) {
    throw notFoundError("Seller not found");
  }

  if (body.email && body.email !== seller.email) {
    const existingEmail = await sellerRepository.findOne({
      email: body.email,
      _id: { $ne: seller._id },
      isActive: true,
    });
    if (existingEmail) {
      throw badRequestError("Email already exists");
    }
  }

  if (body.mobileNo && body.mobileNo !== seller.mobileNo) {
    const existingMobile = await sellerRepository.findOne({
      mobileNo: body.mobileNo,
      _id: { $ne: seller._id },
      isActive: true,
    });
    if (existingMobile) {
      throw badRequestError("Mobile number already exists");
    }
  }

  Object.assign(seller, body, { updatedBy });
  await sellerRepository.save(seller);

  const updatedSeller = await sellerRepository
    .findById(seller._id)
    .populate("createdBy", "first_name last_name email")
    .populate("updatedBy", "first_name last_name email");

  return updatedSeller;
}

async function deleteSeller(id, updatedBy) {
  const seller = await sellerRepository.findById(id);
  if (!seller || !seller.isActive) {
    throw notFoundError("Seller not found");
  }

  // See file-level comment: this require is preserved exactly as it
  // existed in the original controller, including its pre-existing
  // "Cannot find module" failure mode.
  const CarIntake = require("../models/CarIntake");
  const hasCarIntakes = await CarIntake.findOne({
    seller: seller._id,
    isActive: true,
  });

  if (hasCarIntakes) {
    throw badRequestError("Cannot delete seller with existing car intakes");
  }

  seller.isActive = false;
  seller.isDeleted = true;
  seller.deletedAt = new Date();
  seller.updatedBy = updatedBy;
  await sellerRepository.save(seller);
}

async function getSellerCarIntakes(id) {
  // See file-level comment: preserved exactly, including the pre-existing
  // "Cannot find module" failure mode.
  const CarIntake = require("../models/CarIntake");

  const seller = await sellerRepository.findById(id);
  if (!seller || !seller.isActive) {
    throw notFoundError("Seller not found");
  }

  const carIntakes = await CarIntake.find({
    seller: seller._id,
    isActive: true,
  })
    .populate("createdBy", "first_name last_name email")
    .sort({ createdAt: -1 });

  return {
    seller: {
      id: seller._id,
      fullName: seller.fullName,
      email: seller.email,
      mobileNo: seller.mobileNo,
    },
    carIntakes,
  };
}

async function searchSellers(q) {
  if (!q || q.length < 2) {
    throw badRequestError("Search query must be at least 2 characters");
  }

  const searchRegex = new RegExp(q, "i");
  const sellers = await sellerRepository
    .find({
      isActive: true,
      $or: [
        { firstName: searchRegex },
        { lastName: searchRegex },
        { email: searchRegex },
        { mobileNo: searchRegex },
      ],
    })
    .select("firstName lastName email mobileNo")
    .limit(10);

  return sellers;
}

module.exports = {
  createSeller,
  getSellers,
  getSeller,
  updateSeller,
  deleteSeller,
  getSellerCarIntakes,
  searchSellers,
};
