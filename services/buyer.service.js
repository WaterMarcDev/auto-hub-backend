/**
 * Buyer business logic. Extracted 1:1 from controllers/buyer.controller.js
 * during the clean-architecture migration.
 */
const buyerRepository = require("../repositories/buyer.repository");

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function validationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function createBuyer({ firstName, lastName, mobileNo, email, description, createdBy }) {
  if (!firstName || !lastName) {
    throw validationError("First and last name are required");
  }

  const buyer = new (buyerRepository.raw())({
    firstName,
    lastName,
    mobileNo,
    email,
    description,
    createdBy,
  });

  await buyerRepository.save(buyer);
  return buyer;
}

async function getBuyers({ page = 1, limit = 10, search } = {}) {
  const skip = (page - 1) * limit;

  const filter = { isActive: true };
  filter.isDeleted = { $ne: true };
  if (search) {
    const searchRegex = new RegExp(search, "i");
    filter.$or = [
      { firstName: searchRegex },
      { lastName: searchRegex },
      { email: searchRegex },
      { mobileNo: searchRegex },
    ];
  }

  const buyers = await buyerRepository
    .find(filter)
    .populate("createdBy", "first_name last_name email")
    .populate("updatedBy", "first_name last_name email")
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const total = await buyerRepository.countDocuments(filter);

  return { buyers, pagination: { page, limit, total } };
}

async function getBuyerById(id) {
  const buyer = await buyerRepository
    .findOne({ _id: id, isDeleted: { $ne: true } })
    .populate("createdBy", "first_name last_name email")
    .populate("updatedBy", "first_name last_name email");

  if (!buyer) {
    throw notFoundError("Buyer not found");
  }
  return buyer;
}

async function updateBuyer(id, { firstName, lastName, mobileNo, email, description }, updatedBy) {
  const buyer = await buyerRepository.findById(id);

  if (!buyer || !buyer.isActive || buyer.isDeleted) {
    throw notFoundError("Buyer not found");
  }

  if (firstName !== undefined) buyer.firstName = firstName;
  if (lastName !== undefined) buyer.lastName = lastName;
  if (mobileNo !== undefined) buyer.mobileNo = mobileNo;
  if (email !== undefined) buyer.email = email;
  if (description !== undefined) buyer.description = description;
  buyer.updatedBy = updatedBy;

  await buyerRepository.save(buyer);
  return buyer;
}

async function deleteBuyer(id, updatedBy) {
  const buyer = await buyerRepository.findById(id);

  if (!buyer || !buyer.isActive || buyer.isDeleted) {
    throw notFoundError("Buyer not found");
  }

  buyer.isActive = false;
  buyer.isDeleted = true;
  buyer.deletedAt = new Date();
  buyer.updatedBy = updatedBy;

  await buyerRepository.save(buyer);
}

module.exports = {
  createBuyer,
  getBuyers,
  getBuyerById,
  updateBuyer,
  deleteBuyer,
};
