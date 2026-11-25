const EntryFee = require("../models/EntryFee.model");

// Entry fee limits, in dollars (money: at most 2 decimal places).
const ENTRY_FEE_MIN = 0;
const ENTRY_FEE_MAX = 10;
const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;

// Returns { value } for a valid entry fee, or { error } (nothing is saved then).
function parseEntryFee(raw) {
  const rangeError = `Entry fee must be a number from $${ENTRY_FEE_MIN} to $${ENTRY_FEE_MAX} with at most 2 decimal places`;
  if (typeof raw !== "number" && typeof raw !== "string") return { error: rangeError };
  const text = String(raw).trim();
  // Rejects letters, signs, exponents ("1e40"), several dots and >2 decimals.
  if (!MONEY_PATTERN.test(text)) return { error: rangeError };
  const value = Number(text);
  if (!Number.isFinite(value) || value < ENTRY_FEE_MIN || value > ENTRY_FEE_MAX) {
    return { error: rangeError };
  }
  return { value: Math.round(value * 100) / 100 };
}

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
    // Validate before touching the stored setting: an invalid value is
    // rejected with 400 and the current entry fee stays as it is.
    const parsed = parseEntryFee(req.body?.entryFee);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error, message: parsed.error });
    }
    const entryFee = parsed.value;

    // Same document the GET returns (the most recent one).
    let setting = await EntryFee.findOne().sort({ createdAt: -1 });

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

    // Purge cache and notify all connected clients in real-time
    const cacheService = require("../services/cache.service");
    cacheService.delPrefix("master:entryFee");
    req.app.get("io")?.emit("cache:invalidate", { scope: "entryFee", setting: populatedSetting });

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
  parseEntryFee,
  ENTRY_FEE_MIN,
  ENTRY_FEE_MAX,
};
