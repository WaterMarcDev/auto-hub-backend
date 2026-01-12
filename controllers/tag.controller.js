const Tag = require("../models/tag.model");
const { formatBarcode } = require("../utils/barcode");
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

const generateTags = async (req, res) => {
  const { start, end, digits } = req.body;

  if (start == null || end == null || digits == null) {
    return res.status(400).json({
      message: "start, end and digits are required",
    });
  }
  if (digits < 2) {
    return res.status(400).json({
      message: "digits must be at least 2",
    });
  }

  if (start > end) {
    return res.status(400).json({ message: "Invalid range" });
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
    const result = await Tag.insertMany(docs, { ordered: false });
    return res.status(201).json({
      start,
      end,
      digits,
      inserted: result.length,
      skipped: 0,
    });
  } catch (err) {
    const duplicateCount = err.writeErrors?.length || 0;
    const total = docs.length;

    return res.status(201).json({
      start,
      end,
      digits,
      inserted: total - duplicateCount,
      skipped: duplicateCount,
    });
  }
};

const getTag = async (req, res) => {
  const { barcode } = req.params;
  const barcodeNumber = Number(barcode);

  if (Number.isNaN(barcodeNumber)) {
    return res.status(400).json({ message: "Invalid barcode" });
  }

  const tag = await Tag.findOne({ barcodeNumber });
  if (!tag) {
    return res.status(404).json({ message: "Tag not found" });
  }

  res.json(toTagDTO(tag));
};

const getAllTags = async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.max(Number(req.query.limit) || 10, 1);
  const skip = (page - 1) * limit;

  const [tags, total] = await Promise.all([
    Tag.find({}).sort({ barcodeNumber: 1 }).skip(skip).limit(limit),
    Tag.countDocuments({}),
  ]);

  res.json({
    tags: tags.map(toTagDTO),
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
};


const getAvailableTags = async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.max(Number(req.query.limit) || 10, 1);
  const skip = (page - 1) * limit;

  const filter = {
    isUsed: false,
    inventoryId: null,
  };
  const search = req.query.search?.trim();

  if (search) {
    const isNumber = /^\d+$/.test(search);

    filter.$or = isNumber
      ? [
        { barcodeNumber: Number(search) },
        { barcodeString: { $regex: search, $options: "i" } },
      ]
      : [{ barcodeString: { $regex: `^${search}`, $options: "i" } }];
  }


  const [tags, total] = await Promise.all([
    Tag.find(filter).sort({ barcodeNumber: 1 }).skip(skip).limit(limit),
    Tag.countDocuments(filter),
  ]);

  res.json({
    tags: tags.map(toTagDTO),
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
};

const toggleTag = async (req, res) => {
  const barcodeNumber = Number(req.params.barcode);

  if (Number.isNaN(barcodeNumber)) {
    return res.status(400).json({ message: "Invalid barcode" });
  }

  const tag = await Tag.findOneAndUpdate(
    { barcodeNumber },
    [{ $set: { isUsed: { $not: "$isUsed" } } }],
    { new: true }
  );

  if (!tag) {
    return res.status(404).json({ message: "Tag not found" });
  }

  res.json(toTagDTO(tag));
};

const attachTagToPart = async (req, res) => {
  const { barcode } = req.params;
  const { inventoryId } = req.body;

  if (!barcode) {
    return res.status(400).json({ message: "Barcode is required" });
  }

  if (!inventoryId) {
    return res.status(400).json({ message: "inventoryId is required" });
  }

  const tag = await Tag.findOneAndUpdate(
    {
      barcodeString: barcode,
      inventoryId: null,
    },
    {
      inventoryId,
      isUsed: true,
    },
    { new: true }
  );

  if (!tag) {
    return res.status(409).json({
      message: "Tag already assigned or does not exist",
    });
  }

  res.json(toTagDTO(tag));
};




module.exports = {
  generateTags,
  getTag,
  getAllTags,
  getAvailableTags,
  toggleTag,
  attachTagToPart,
};


