/**
 * Trim business logic. Extracted 1:1 from controllers/trim.controller.js
 * during the clean-architecture migration.
 */
const trimRepository = require("../repositories/trim.repository");

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

async function createTrim({ name, make, model, shortName, description }) {
  const existingTrim = await trimRepository.findOne({ name, make, model });
  if (existingTrim) {
    throw conflictError("Trim with this name already exists for the specified make and model");
  }
  return trimRepository.create({ name, make, model, shortName, description });
}

async function getAllTrims({ page = 1, limit = 10, search, make, model } = {}) {
  const skip = (page - 1) * limit;

  const filter = {};
  filter.isDeleted = { $ne: true };
  if (search) filter.name = { $regex: search, $options: "i" };
  if (make) filter.make = make;
  if (model) filter.model = model;

  const total = await trimRepository.countDocuments(filter);
  const trims = await trimRepository
    .find(filter)
    .populate("make")
    .populate("model")
    .skip(skip)
    .limit(limit)
    .sort({ name: 1 });

  return { trims, pagination: { page, limit, total } };
}

async function getTrimById(id) {
  const trim = await trimRepository
    .findOne({ _id: id, isDeleted: { $ne: true } })
    .populate("make")
    .populate("model");
  if (!trim) {
    throw notFoundError("Trim not found");
  }
  return trim;
}

async function updateTrim(id, { name, make, model, shortName, description }) {
  const trim = await trimRepository
    .findByIdAndUpdate(id, { name, make, model, shortName, description }, { new: true })
    .populate("make")
    .populate("model");
  if (!trim) {
    throw notFoundError("Trim not found");
  }
  return trim;
}

async function deleteTrim(id) {
  const trim = await trimRepository.findById(id);
  if (!trim || trim.isDeleted) {
    throw notFoundError("Trim not found");
  }

  trim.isDeleted = true;
  trim.deletedAt = new Date();
  await trimRepository.save(trim);
}

module.exports = {
  createTrim,
  getAllTrims,
  getTrimById,
  updateTrim,
  deleteTrim,
};
