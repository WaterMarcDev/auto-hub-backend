/**
 * Part (catalog master part) business logic. Extracted 1:1 from
 * controllers/part.controller.js during the clean-architecture migration.
 * NOTE: the original controller checks/sets BOTH `deleted` and `isDeleted`
 * fields in a few places — that dual-field pattern is preserved exactly
 * (not consolidated), since this migration must not change behavior.
 */
const partRepository = require("../repositories/part.repository");

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

async function createPart({ name, shortName, category, unit, weight, dimensions, image, description }) {
  const existingPart = await partRepository.findOne({ name, deleted: { $ne: true } });
  if (existingPart) {
    throw conflictError("Part with this name already exists");
  }

  return partRepository.create({ name, shortName, category, unit, weight, dimensions, image, description });
}

async function getAllParts({ page = 1, limit = 10, search } = {}) {
  const skip = (page - 1) * limit;

  const filter = { deleted: { $ne: true } };
  if (search) filter.name = { $regex: search, $options: "i" };

  const parts = await partRepository.find(filter).skip(skip).limit(limit).sort({ name: 1 });
  const total = await partRepository.countDocuments(filter);

  return { parts, pagination: { page, limit, total } };
}

async function getPartById(id) {
  const part = await partRepository.findOne({
    _id: id,
    $or: [{ deleted: { $ne: true } }, { isDeleted: { $ne: true } }],
  });
  if (!part || part.deleted || part.isDeleted) {
    throw notFoundError("Part not found");
  }
  return part;
}

async function updatePart(id, { name, shortName, category, unit, weight, dimensions, image, description }) {
  const existing = await partRepository.findById(id);
  if (!existing || existing.deleted) {
    throw notFoundError("Part not found");
  }

  return partRepository.findByIdAndUpdate(
    id,
    { name, shortName, category, unit, weight, dimensions, image, description },
    { new: true }
  );
}

async function deletePart(id) {
  const part = await partRepository.findById(id);
  if (!part || part.deleted) {
    throw notFoundError("Part not found");
  }

  part.deleted = true;
  part.isDeleted = true;
  part.deletedAt = new Date();
  await partRepository.save(part);
}

module.exports = {
  createPart,
  getAllParts,
  getPartById,
  updatePart,
  deletePart,
};
