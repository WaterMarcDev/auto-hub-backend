const tagService = require("../services/tag.service");

const generateTags = async (req, res) => {
    const { start, end, digits } = req.body;

    if (!start || !end || !digits) {
        return res.status(400).json({
        message: "start, end and digits are required",
    });
}

    const result = await tagService.bulkCreateTags({ start, end, digits });

    res.status(201).json({
        inserted: result.length,
        start,
        end,
        digits,
    });
};

const getTag = async (req, res) => {
    const { barcode } = req.params;
    const tag = await tagService.getTagByBarcode(barcode);

    if (!tag) return res.status(404).json({ message: "Tag not found" });

    res.json(tag);
};

const deleteTag = async (req, res) => {
    const { barcode } = req.params;
    const tag = await tagService.deleteTagByBarcode(barcode);

    if (!tag) return res.status(404).json({ message: "Tag not found" });

    res.json({ message: "Tag deleted" });
};

const toggleTag = async (req, res) => {
    const { barcode } = req.params;
    const tag = await tagService.toggleTagUsage(barcode);

    if (!tag) return res.status(404).json({ message: "Tag not found" });

    res.json(tag);
};

const getAvailableTags = async (req, res) => {
    const { limit, skip } = req.query;

    const tags = await tagService.getAvailableTags({
        limit: Number(limit) || 50,
        skip: Number(skip) || 0,
    });

    res.json({
        count: tags.length,
        tags,
    });
};

const getAllTags = async (req, res) => {
    const tags = await tagService.getAllTags();
    res.json(tags);
};

module.exports = {
    generateTags,
    getTag,
    deleteTag,
    toggleTag,
    getAvailableTags,
    getAllTags,
};
