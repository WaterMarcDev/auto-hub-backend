const Tag = require("../models/Tag.model");

const padBarcode = (num, digits) => {
  return String(num).padStart(digits, "0");
};

const bulkCreateTags = async ({ start, end, digits }) => {
  if (start > end) throw new Error("start cannot be greater than end");

  const maxAllowed = Math.pow(10, digits) - 1;
  if (end > maxAllowed) {
    throw new Error(`end exceeds max value for ${digits} digits`);
  }

  const tags = [];

  for (let i = start; i <= end; i++) {
    tags.push({ barcode: padBarcode(i, digits) });
  }

  return Tag.insertMany(tags, { ordered: false });
};

const getTagByBarcode = async (barcode) => {
  return Tag.findOne({ barcode });
};

const deleteTagByBarcode = async (barcode) => {
  return Tag.findOneAndDelete({ barcode });
};

const toggleTagUsage = async (barcode) => {
  return Tag.findOneAndUpdate(
    { barcode },
    [{ $set: { isUsed: { $not: "$isUsed" } } }],
    { new: true }
  );
};

const getAvailableTags = async ({ limit = 50, skip = 0 }) => {
  console.log("reached getAvailableTags");
  return Tag.find({ isUsed: false })
    .sort({ barcode: 1 })
    .skip(skip)
    .limit(limit);
};

const getAllTags = async () => {
  return Tag.find();
};

module.exports = {
  bulkCreateTags,
  getTagByBarcode,
  deleteTagByBarcode,
  toggleTagUsage,
  getAvailableTags,
  getAllTags,
};
