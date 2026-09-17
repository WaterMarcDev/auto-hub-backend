/**
 * Car model (make/model) business logic. Extracted 1:1 from
 * controllers/model.controller.js during the clean-architecture migration.
 */
const modelRepository = require("../repositories/model.repository");

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

async function createModel({ name, make, shortName, description }) {
  const existingModel = await modelRepository.findOne({ name, make });
  if (existingModel) {
    throw conflictError("Model with this name already exists for the specified make");
  }
  return modelRepository.create({ name, make, shortName, description });
}

async function getAllModels({ page = 1, limit = 10, search, make } = {}) {
  const skip = (page - 1) * limit;

  const filter = {};
  filter.isDeleted = { $ne: true };
  if (search) filter.name = { $regex: search, $options: "i" };
  if (make) filter.make = make;

  const total = await modelRepository.countDocuments(filter);
  const models = await modelRepository
    .find(filter)
    .populate("make")
    .skip(skip)
    .limit(limit)
    .sort({ name: 1 });

  return { models, pagination: { page, limit, total } };
}

async function getModelById(id) {
  const model = await modelRepository
    .findOne({ _id: id, isDeleted: { $ne: true } })
    .populate("make");
  if (!model) {
    throw notFoundError("Model not found");
  }
  return model;
}

async function updateModel(id, updateData) {
  const model = await modelRepository
    .findByIdAndUpdate(id, updateData, { new: true, runValidators: true })
    .populate("make");
  if (!model) {
    throw notFoundError("Model not found");
  }
  return model;
}

async function deleteModel(id) {
  const model = await modelRepository.findById(id);
  if (!model || model.isDeleted) {
    throw notFoundError("Model not found");
  }

  model.isDeleted = true;
  model.deletedAt = new Date();
  await modelRepository.save(model);
}

module.exports = {
  createModel,
  getAllModels,
  getModelById,
  updateModel,
  deleteModel,
};
