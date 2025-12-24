const tagService = require("../services/tag.service");

const generateTags = async (req, res) => {
    const { start, end, digits } = req.body;

    if (start == null || end == null || digits == null) {
        return res.status(400).json({
        message: "start, end and digits are required",
        });
    }

    const result = await tagService.generateTags({ start, end, digits });

    res.status(201).json({
        start,
        end,
        digits,
        inserted: result.inserted,
        skipped: result.skipped,
    });
};

const getTag = async (req, res) => {
    const { barcode } = req.params;

    const tag = await tagService.getTag({ barcode });
    if (!tag) {
        return res.status(404).json({ message: "Tag not found" });
    }

    res.json(tag);
};

const getAllTags = async (req, res) => {
    const { limit = 50, skip = 0 } = req.query;

    const tags = await tagService.getAllTags({
        limit: Number(limit),
        skip: Number(skip),
    });

    res.json({
        count: tags.length,
        tags,
    });
};

const getAvailableTags = async (req, res) => {
    const { limit = 50, skip = 0 } = req.query;

    const tags = await tagService.getAvailableTags({
        limit: Number(limit),
        skip: Number(skip),
    });

    res.json({
        count: tags.length,
        tags,
    });
};

const toggleTag = async (req, res) => {
    const { barcode } = req.params;

    const tag = await tagService.toggleTag({ barcode });
    if (!tag) {
        return res.status(404).json({ message: "Tag not found" });
    }

    res.json(tag);
};

const deleteTag = async (req, res) => {
    const { barcode } = req.params;

    const tag = await tagService.deleteTag({ barcode });
    if (!tag) {
        return res.status(404).json({ message: "Tag not found" });
    }

    res.json({
        message: "Tag deleted",
        tag,
    });
};

module.exports = {
    generateTags,
    getTag,
    getAllTags,
    getAvailableTags,
    toggleTag,
    deleteTag,
};
