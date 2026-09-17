/**
 * Tag (physical inventory barcode tag) business logic. Extracted 1:1 from
 * controllers/tag.controller.js during the clean-architecture migration.
 *
 * IMPORTANT: most of the original controller functions had NO try/catch —
 * that is preserved exactly here (no error boundary is added where none
 * existed), since adding one would change behavior on an unexpected
 * Mongoose error (it would currently propagate as an unhandled rejection
 * rather than a formatted error response).
 */
const tagRepository = require("../repositories/tag.repository");
const { formatBarcode } = require("../utils/barcode");

function validationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function conflictError(message) {
  const err = new Error(message);
  err.statusCode = 409;
  return err;
}

const toTagDTO = (tag) => ({
  id: tag._id,
  barcodeNumber: tag.barcodeNumber,
  barcodeString: tag.barcodeString,
  digits: tag.digits,
  isUsed: tag.isUsed,
  inventoryId: tag.inventoryId,
  createdAt: tag.createdAt,
  updatedAt: tag.updatedAt,
});

async function generateTags({ start, end, digits }) {
  if (start == null || end == null || digits == null) {
    throw validationError("start, end and digits are required");
  }
  if (digits < 2) {
    throw validationError("digits must be at least 2");
  }
  if (start > end) {
    throw validationError("Invalid range");
  }

  const docs = [];
  for (let i = start; i <= end; i++) {
    docs.push({
      barcodeNumber: i,
      digits,
      barcodeString: formatBarcode(i, digits),
    });
  }

  try {
    const result = await tagRepository.insertMany(docs, { ordered: false });
    return { start, end, digits, inserted: result.length, skipped: 0 };
  } catch (err) {
    const duplicateCount = err.writeErrors?.length || 0;
    const total = docs.length;
    return { start, end, digits, inserted: total - duplicateCount, skipped: duplicateCount };
  }
}

async function getTag(barcode) {
  const barcodeNumber = Number(barcode);
  if (Number.isNaN(barcodeNumber)) {
    throw validationError("Invalid barcode");
  }

  const tag = await tagRepository.findOne({ barcodeNumber });
  if (!tag) {
    throw notFoundError("Tag not found");
  }
  return toTagDTO(tag);
}

async function getAllTags({ page, limit }) {
  const safePage = Math.max(Number(page) || 1, 1);
  const safeLimit = Math.max(Number(limit) || 10, 1);
  const skip = (safePage - 1) * safeLimit;

  const [tags, total] = await Promise.all([
    tagRepository
      .find({})
      .populate({
        path: "inventoryId",
        populate: [
          { path: "make", select: "name" },
          { path: "model", select: "name" },
          { path: "trim", select: "name" },
        ],
      })
      .sort({ barcodeNumber: 1 })
      .skip(skip)
      .limit(safeLimit),
    tagRepository.countDocuments({}),
  ]);

  return {
    tags: tags.map(toTagDTO),
    pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) },
  };
}

async function getAvailableTags({ page, limit, search }) {
  const safePage = Math.max(Number(page) || 1, 1);
  const safeLimit = Math.max(Number(limit) || 10, 1);
  const skip = (safePage - 1) * safeLimit;

  const filter = { isUsed: false, inventoryId: null };
  const trimmedSearch = search?.trim();

  if (trimmedSearch) {
    const isNumber = /^\d+$/.test(trimmedSearch);
    filter.$or = isNumber
      ? [
          { barcodeNumber: Number(trimmedSearch) },
          { barcodeString: { $regex: trimmedSearch, $options: "i" } },
        ]
      : [{ barcodeString: { $regex: `^${trimmedSearch}`, $options: "i" } }];
  }

  const [tags, total] = await Promise.all([
    tagRepository.find(filter).sort({ barcodeNumber: 1 }).skip(skip).limit(safeLimit),
    tagRepository.countDocuments(filter),
  ]);

  return {
    tags: tags.map(toTagDTO),
    pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) },
  };
}

async function toggleTag(barcode) {
  const barcodeNumber = Number(barcode);
  if (Number.isNaN(barcodeNumber)) {
    throw validationError("Invalid barcode");
  }

  const tag = await tagRepository.findOneAndUpdate(
    { barcodeNumber },
    [{ $set: { isUsed: { $not: "$isUsed" } } }],
    { new: true }
  );

  if (!tag) {
    throw notFoundError("Tag not found");
  }
  return toTagDTO(tag);
}

async function attachTagToPart(barcode, inventoryId) {
  if (!barcode) {
    throw validationError("Barcode is required");
  }
  if (!inventoryId) {
    throw validationError("inventoryId is required");
  }

  const tag = await tagRepository.findOneAndUpdate(
    { barcodeString: barcode, inventoryId: null },
    { inventoryId, isUsed: true },
    { new: true }
  );

  if (!tag) {
    throw conflictError("Tag already assigned or does not exist");
  }
  return toTagDTO(tag);
}

module.exports = {
  generateTags,
  getTag,
  getAllTags,
  getAvailableTags,
  toggleTag,
  attachTagToPart,
};
