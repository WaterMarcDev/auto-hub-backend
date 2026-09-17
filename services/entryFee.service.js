/**
 * Entry fee (junkyard/scale entry fee setting) business logic. Extracted
 * 1:1 from controllers/entryFee.controller.js during the clean-architecture
 * migration.
 */
const entryFeeRepository = require("../repositories/entryFee.repository");

function validationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function getEntryFee() {
  const setting = await entryFeeRepository
    .findOne()
    .sort({ createdAt: -1 })
    .populate("updatedBy", "first_name last_name email");

  if (!setting) {
    return { isDefault: true, setting: { entryFee: 2.0, isDefault: true } };
  }

  return { isDefault: false, setting };
}

async function updateEntryFee(entryFee, updatedBy) {
  if (entryFee === undefined || isNaN(entryFee)) {
    throw validationError("Valid entry fee is required");
  }

  let setting = await entryFeeRepository.findOne();

  if (setting) {
    setting.entryFee = entryFee;
    setting.updatedBy = updatedBy;
    await entryFeeRepository.save(setting);
  } else {
    setting = new (entryFeeRepository.raw())({ entryFee, updatedBy });
    await entryFeeRepository.save(setting);
  }

  return entryFeeRepository
    .findById(setting._id)
    .populate("updatedBy", "first_name last_name email");
}

module.exports = {
  getEntryFee,
  updateEntryFee,
};
