const entryFeeService = require("../services/entryFee.service");

// @desc    Get entry fee setting
// @route   GET /api/entry-fee
// @access  Private/Admin
const getEntryFee = async (req, res) => {
  try {
    const { setting } = await entryFeeService.getEntryFee();
    res.json({ success: true, setting });
  } catch (error) {
    console.error("Get entry fee error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Update entry fee setting
// @route   PUT /api/entry-fee
// @access  Private/Admin
const updateEntryFee = async (req, res) => {
  try {
    const { entryFee } = req.body;
    const populatedSetting = await entryFeeService.updateEntryFee(entryFee, req.user._id);

    res.json({
      success: true,
      message: "Entry fee updated successfully",
      setting: populatedSetting,
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error("Update entry fee error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = {
  getEntryFee,
  updateEntryFee,
};
