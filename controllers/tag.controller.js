const Tag = require("../models/Tag.model");
const {
  TAG_DIGITS,
  MAX_TAG_NUMBER,
  MAX_TAGS_PER_BATCH,
  formatBarcode,
  parseBarcode,
} = require("../utils/barcode");
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

// Accepts a whole number given as a number or a digits-only string; NaN otherwise.
const toWholeNumber = (value) => {
  if (typeof value === "number") return Number.isInteger(value) ? value : NaN;
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) return Number(value);
  return NaN;
};

// Sorted tag numbers -> readable ranges, e.g. [1,2,3,7] -> "1–3 (AUT000001–AUT000003), 7 (AUT000007)".
const describeTagNumbers = (numbers, maxRanges = 5) => {
  const ranges = [];
  for (const n of numbers) {
    const last = ranges[ranges.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  const shown = ranges.slice(0, maxRanges).map(([a, b]) =>
    a === b
      ? `${a} (${formatBarcode(a)})`
      : `${a}–${b} (${formatBarcode(a)}–${formatBarcode(b)})`
  );
  const more = ranges.length - shown.length;
  return shown.join(", ") + (more > 0 ? ` and ${more} more range(s)` : "");
};

const isDuplicateKeyError = (err) =>
  err?.code === 11000 ||
  (err?.writeErrors || []).some((e) => (e?.code ?? e?.err?.code) === 11000) ||
  /E11000/.test(err?.message || "");

const generateTags = async (req, res) => {
  // The tag format is fixed on the server (see utils/barcode.js); any
  // "digits" sent by the client is ignored so every tag looks the same.
  const start = toWholeNumber(req.body?.start);
  const end = toWholeNumber(req.body?.end);

  if (Number.isNaN(start) || Number.isNaN(end)) {
    return res.status(400).json({ message: "Start and end must be whole numbers" });
  }
  if (start < 1 || end > MAX_TAG_NUMBER) {
    return res.status(400).json({
      message: `Tag numbers must be between 1 and ${MAX_TAG_NUMBER}`,
    });
  }
  if (start > end) {
    return res.status(400).json({ message: "Start must be less than or equal to end" });
  }
  const count = end - start + 1;
  if (count > MAX_TAGS_PER_BATCH) {
    return res.status(400).json({
      message: `You can generate at most ${MAX_TAGS_PER_BATCH} tags at a time (this range has ${count})`,
    });
  }

  try {
    // Refuse the whole range if any number in it already has a tag, instead
    // of silently skipping the duplicates and reporting success.
    const existing = await Tag.find({ barcodeNumber: { $gte: start, $lte: end } })
      .select("barcodeNumber")
      .sort({ barcodeNumber: 1 })
      .lean();
    if (existing.length) {
      const numbers = existing.map((t) => t.barcodeNumber);
      return res.status(409).json({
        message: `Asset tags ${describeTagNumbers(numbers)} already exist. Choose a range that does not include them.`,
        existing: numbers,
      });
    }

    // One timestamp for the whole batch, saved as createdAt (the date the
    // tag was generated, shown in the Asset Tags list).
    const generatedAt = new Date();
    const docs = [];
    for (let i = start; i <= end; i++) {
      docs.push({
        barcodeNumber: i,
        digits: TAG_DIGITS,
        barcodeString: formatBarcode(i),
        createdAt: generatedAt,
        updatedAt: generatedAt,
      });
    }

    await Tag.insertMany(docs, { ordered: true });
    return res.status(201).json({
      start,
      end,
      digits: TAG_DIGITS,
      inserted: docs.length,
      from: formatBarcode(start),
      to: formatBarcode(end),
      generatedAt,
    });
  } catch (err) {
    // Two requests for the same numbers at once (e.g. a double-click) can
    // both pass the check above; the unique index stops the second one here.
    if (isDuplicateKeyError(err)) {
      return res.status(409).json({
        message: `Asset tags in ${start}–${end} were just created by another request. Refresh the list before generating again.`,
      });
    }
    console.error("Failed to generate asset tags:", err);
    return res.status(500).json({ message: "Failed to generate asset tags" });
  }
};

const getTag = async (req, res) => {
  const { barcode } = req.params;
  // Accept the printed code (AUT000123) as well as the bare number.
  const barcodeNumber = parseBarcode(barcode);

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
    Tag.find({})
      .populate({
        path: 'inventoryId',
        populate: [
          { path: 'make', select: 'name' },
          { path: 'model', select: 'name' },
          { path: 'trim', select: 'name' }
        ]
      })
      .sort({ barcodeNumber: 1 })
      .skip(skip)
      .limit(limit),
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
  const barcodeNumber = parseBarcode(req.params.barcode);

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


