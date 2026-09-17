const tagService = require("../services/tag.service");

// NOTE: these controller functions intentionally have NO try/catch, exactly
// matching the pre-refactor controller — an unexpected error currently
// propagates as an unhandled rejection rather than a formatted response.
// Validation/not-found/conflict errors ARE handled below because the
// original code handled those specific cases explicitly (via early
// `return res.status(...)` checks) — this preserves that exact behavior by
// checking `error.statusCode` (set only for those known cases) and
// re-throwing anything else so it propagates identically to before.

const generateTags = async (req, res) => {
  try {
    const result = await tagService.generateTags(req.body);
    return res.status(201).json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    throw error;
  }
};

const getTag = async (req, res) => {
  try {
    const dto = await tagService.getTag(req.params.barcode);
    res.json(dto);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    throw error;
  }
};

const getAllTags = async (req, res) => {
  const result = await tagService.getAllTags({ page: req.query.page, limit: req.query.limit });
  res.json(result);
};

const getAvailableTags = async (req, res) => {
  const result = await tagService.getAvailableTags({
    page: req.query.page,
    limit: req.query.limit,
    search: req.query.search,
  });
  res.json(result);
};

const toggleTag = async (req, res) => {
  try {
    const dto = await tagService.toggleTag(req.params.barcode);
    res.json(dto);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    throw error;
  }
};

const attachTagToPart = async (req, res) => {
  try {
    const dto = await tagService.attachTagToPart(req.params.barcode, req.body.inventoryId);
    res.json(dto);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    throw error;
  }
};

module.exports = {
  generateTags,
  getTag,
  getAllTags,
  getAvailableTags,
  toggleTag,
  attachTagToPart,
};
