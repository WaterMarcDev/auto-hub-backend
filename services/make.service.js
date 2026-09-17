/**
 * Make (vehicle manufacturer) business logic. Extracted 1:1 from
 * controllers/make.controller.js during the clean-architecture migration —
 * every rule, message, and status code below is intentionally unchanged.
 */
const makeRepository = require("../repositories/make.repository");

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function conflictError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function createMake({ name, shortName, description }) {
  const existingMake = await makeRepository.findOne({ name });
  if (existingMake) {
    throw conflictError("Make with this name already exists");
  }
  return makeRepository.create({ name, shortName, description });
}

async function getAllMakes({ page = 1, limit = 10, search } = {}) {
  const skip = (page - 1) * limit;

  const filter = {};
  filter.isDeleted = { $ne: true };
  if (search) {
    filter.name = { $regex: search, $options: "i" };
  }

  const total = await makeRepository.countDocuments(filter);
  const makes = await makeRepository
    .find(filter)
    .skip(skip)
    .limit(limit)
    .sort({ name: 1 });

  return {
    makes,
    pagination: { page, limit, total },
  };
}

async function getMakeById(id) {
  const make = await makeRepository.findOne({
    _id: id,
    isDeleted: { $ne: true },
  });
  if (!make) {
    throw notFoundError("Make not found");
  }
  return make;
}

async function updateMake(id, { name, shortName, description }) {
  // NOTE: preserves the original controller's exact call shape —
  // `{ isDeleted: false }` here is a Mongoose PROJECTION argument (2nd
  // positional arg to findById), not a filter. That is how the original
  // code called it; replicated faithfully rather than "corrected", since
  // this migration must not change existing behavior.
  const make = await makeRepository.findById(id, { isDeleted: false });
  if (!make) {
    throw notFoundError("Make not found");
  }

  make.name = name || make.name;
  make.shortName = shortName || make.shortName;
  make.description = description || make.description;

  await makeRepository.save(make);
  return make;
}

async function deleteMake(id) {
  const make = await makeRepository.findById(id, { isDeleted: false });
  if (!make) {
    throw notFoundError("Make not found");
  }

  make.isDeleted = true;
  make.deletedAt = new Date();
  await makeRepository.save(make);
}

module.exports = {
  createMake,
  getAllMakes,
  getMakeById,
  updateMake,
  deleteMake,
};
