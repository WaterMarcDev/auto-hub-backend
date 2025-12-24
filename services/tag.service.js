const Tag = require("../models/tag.model");
const {formatBarcode} = require("../utils/barcode");

const attachTagToPart = async ({ barcode, partId }) => {
  const barcodeNumber = Number(barcode);

  const tag = await Tag.findOneAndUpdate(
    {
      barcodeNumber,
      partId: null,
    },
    {
      partId,
      isUsed: true,
    },
    { new: true }
  );

  return tag ? toTagDTO(tag) : null;
};

const detachTagFromPart = async ({ barcode }) => {
  const barcodeNumber = Number(barcode);

  const tag = await Tag.findOneAndUpdate(
    { barcodeNumber },
    {
      partId: null,
      isUsed: false,
    },
    { new: true }
  );

  return tag ? toTagDTO(tag) : null;
};


const toTagDTO = (tag) => ({
  id: tag._id,
  barcodeNumber: tag.barcodeNumber,
  barcodeString: formatBarcode(tag.barcodeNumber, tag.digits),
  digits: tag.digits,
  isUsed: tag.isUsed,
  createdAt: tag.createdAt,
  updatedAt: tag.updatedAt,
});

const generateTags = async ({ start, end, digits }) => {
  if (start > end) throw new Error("Invalid range");

  const docs = [];
  for (let i = start; i <= end; i++) {
    docs.push({
      barcodeNumber: i,
      digits,
    });
  }

  try {
    const result = await Tag.insertMany(docs, { ordered: false });
    return {
      inserted: result.length,
      skipped: 0,
    };
  } catch (err) {
    const duplicateCount = err.writeErrors?.length || 0;
    const total = docs.length;

    return {
      inserted: total - duplicateCount,
      skipped: duplicateCount,
    };
  }
};

const getTag = async ({ barcode }) => {
  const barcodeNumber = Number(barcode);
  if (Number.isNaN(barcodeNumber)) return null;

  const tag = await Tag.findOne({ barcodeNumber });
  return tag ? toTagDTO(tag) : null;
};

const getAllTags = async ({ limit = 50, skip = 0 }) => {
  const tags = await Tag.find({})
    .sort({ barcodeNumber: 1 })
    .skip(skip)
    .limit(limit);

  return tags.map(toTagDTO);
};

const getAvailableTags = async ({ limit = 50, skip = 0 }) => {
  const tags = await Tag.find({ isUsed: false, partId: null})
    .sort({ barcodeNumber: 1 })
    .skip(skip)
    .limit(limit);

  return tags.map(toTagDTO);
};

const toggleTag = async ({ barcode }) => {
  const barcodeNumber = Number(barcode);

  const tag = await Tag.findOneAndUpdate(
    { barcodeNumber },
    [{ $set: { isUsed: { $not: "$isUsed" } } }],
    { new: true }
  );

  return tag ? toTagDTO(tag) : null;
};

const deleteTag = async ({ barcode }) => {
  const barcodeNumber = Number(barcode);
  const tag = await Tag.findOneAndDelete({ barcodeNumber });

  return tag ? toTagDTO(tag) : null;
};

module.exports = {
  generateTags,
  getTag,
  getAllTags,
  getAvailableTags,
  toggleTag,
  deleteTag,
  attachTagToPart,
  detachTagFromPart,
};
