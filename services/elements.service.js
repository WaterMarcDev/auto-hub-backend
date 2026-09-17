/**
 * Element (recyclable material type) business logic. Extracted 1:1 from
 * controllers/elements.controller.js during the clean-architecture
 * migration.
 */
const elementsRepository = require("../repositories/elements.repository");

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

async function createElement({ name, shortName, weight, dimensions, description }) {
  const existingElement = await elementsRepository.findOne({ name });
  if (existingElement) {
    throw conflictError("Element with this name already exists");
  }

  return elementsRepository.create({ name, shortName, weight, dimensions, description });
}

async function getAllElements({ page = 1, limit = 10, search } = {}) {
  const skip = (page - 1) * limit;

  const filter = {};
  filter.isDeleted = { $ne: true };
  if (search) filter.name = { $regex: search, $options: "i" };

  const elements = await elementsRepository.find(filter).skip(skip).limit(limit).sort({ name: 1 });
  const total = await elementsRepository.countDocuments(filter);

  return { elements, pagination: { page, limit, total } };
}

async function getElementById(id) {
  const element = await elementsRepository.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!element) {
    throw notFoundError("Element not found");
  }
  return element;
}

async function updateElement(id, { name, shortName, weight, dimensions, description }) {
  const element = await elementsRepository.findByIdAndUpdate(
    id,
    { name, shortName, weight, dimensions, description },
    { new: true }
  );

  if (!element) {
    throw notFoundError("Element not found");
  }
  return element;
}

async function deleteElement(id) {
  const element = await elementsRepository.findById(id);
  if (!element || element.isDeleted) {
    throw notFoundError("Element not found");
  }

  element.isDeleted = true;
  element.deletedAt = new Date();
  await elementsRepository.save(element);
}

module.exports = {
  createElement,
  getAllElements,
  getElementById,
  updateElement,
  deleteElement,
};
