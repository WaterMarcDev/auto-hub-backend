const EntryFee = require("../models/EntryFee.model");

// GET /api/entry-fee
const getEntryFee = async (req, res) => {
  try {
    const setting = await EntryFee.findOne().sort({ createdAt: -1 }).populate("updatedBy", "first_name last_name email");
    if (!setting) return res.json({ success: true, setting: { entryFee: 2.0, isDefault: true } });
    res.json({ success: true, setting });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// PUT /api/entry-fee
const updateEntryFee = async (req, res) => {
  try {
    const { entryFee } = req.body;
    if (entryFee === undefined || isNaN(entryFee)) return res.status(400).json({ error: "Valid entry fee is required" });

    let setting = await EntryFee.findOne();
    if (setting) {
      setting.entryFee = entryFee;
      setting.updatedBy = req.user._id;
      await setting.save();
    } else {
      setting = await new EntryFee({ entryFee, updatedBy: req.user._id }).save();
    }
    const populated = await EntryFee.findById(setting._id).populate("updatedBy", "first_name last_name email");
    res.json({ success: true, message: "Entry fee updated successfully", setting: populated });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = { getEntryFee, updateEntryFee };
