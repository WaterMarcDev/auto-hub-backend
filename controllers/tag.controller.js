const Tag = require("../models/tag.model");
const { formatBarcode } = require("../utils/barcode");
const toTagDTO = (tag) => ({
    id: tag._id,
    barcodeNumber: tag.barcodeNumber,
    barcodeString: formatBarcode(tag.barcodeNumber, tag.digits),
    digits: tag.digits,
    isUsed: tag.isUsed,
    partId: tag.partId,
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

    if (start > end) {
        return res.status(400).json({ message: "Invalid range" });
    }

    const docs = [];
    for (let i = start; i <= end; i++) {
        docs.push({ barcodeNumber: i, digits });
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
    const { limit = 50, skip = 0 } = req.query;

    const tags = await Tag.find({})
        .sort({ barcodeNumber: 1 })
        .skip(Number(skip))
        .limit(Number(limit));

    res.json({
        count: tags.length,
        tags: tags.map(toTagDTO),
    });
};

const getAvailableTags = async (req, res) => {
    const { limit = 50, skip = 0 } = req.query;

    const tags = await Tag.find({
        isUsed: false,
        partId: null,
    })
    .sort({ barcodeNumber: 1 })
    .skip(Number(skip))
    .limit(Number(limit));

    res.json({
        count: tags.length,
        tags: tags.map(toTagDTO),
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
    const barcodeNumber = Number(req.params.barcode);
    const { partId } = req.body;

    if (Number.isNaN(barcodeNumber)) {
        return res.status(400).json({ message: "Invalid barcode" });
    }

    if (!partId) {
        return res.status(400).json({ message: "partId is required" });
    }

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
