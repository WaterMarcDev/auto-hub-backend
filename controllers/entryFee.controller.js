const EntryFee = require("../models/EntryFee.model");

// @desc    Get entry fee setting
// @route   GET /api/entry-fee
// @access  Private/Admin
const getEntryFee = async (req, res) => {
  try {
    let setting = await EntryFee.findOne().sort({ createdAt: -1 }).populate("updatedBy", "first_name last_name email");

    if (!setting) {
      // Return default if not found
      return res.json({
        success: true,
        setting: {
          entryFee: 2.0,
          isDefault: true
        }
      });
    }

    res.json({
      success: true,
      setting,
    });
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

    if (entryFee === undefined || isNaN(entryFee)) {
      return res.status(400).json({ error: "Valid entry fee is required" });
    }

    let setting = await EntryFee.findOne();

    if (setting) {
      setting.entryFee = entryFee;
      setting.updatedBy = req.user._id;
      await setting.save();
    } else {
      setting = new EntryFee({
        entryFee,
        updatedBy: req.user._id,
      });
      await setting.save();
    }

    const populatedSetting = await EntryFee.findById(setting._id).populate("updatedBy", "first_name last_name email");

    res.json({
      success: true,
      message: "Entry fee updated successfully",
      setting: populatedSetting,
    });
  } catch (error) {
    console.error("Update entry fee error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = {
  getEntryFee,
  updateEntryFee,
};
