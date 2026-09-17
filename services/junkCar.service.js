/**
 * Junk Car Request business logic. Extracted 1:1 from
 * controllers/junkCar.controller.js during the clean-architecture
 * migration — every rule, default, source-mapping table, and side effect
 * (auto-creating a CarIntake record on completed+paid) is preserved exactly.
 */
const junkCarRepository = require("../repositories/junkCar.repository");
const carIntakeRepository = require("../repositories/carIntake.repository");

const SOURCE_MAP = {
  website: "website",
  online: "website",
  instagram: "instagram",
  facebook: "facebook",
  tiktok: "tiktok",
  ebay: "ebay",
  "google business": "google business",
  whatsapp: "whatsApp",
  sms: "sms",
  other: "other",
};

function validationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function parseYear(year) {
  if (!year) return null;
  const yearStr = year.toString().trim();
  if (!/^\d{4}$/.test(yearStr)) {
    throw validationError("Year must be exactly 4 digits");
  }
  return parseInt(yearStr, 10);
}

async function createJunkCarRequest(body) {
  const { name, email, phone, year, make, model, engineOrVin, condition, message } = body;
  const parsedYear = parseYear(year);

  // Was previously dropped — see PartRequestController.createRequest for the
  // equivalent pattern (kept byte-for-byte symmetric with it: raw
  // passthrough, no normalization, so Junk Car can never diverge from Part
  // Request's own casing/behavior).
  const normalizedSource = "website";

  return junkCarRepository.create({
    name: name || "none",
    email: email || "none",
    phone: phone || "none",
    year: parsedYear,
    make: make || "none",
    model: model || "none",
    engineOrVin: engineOrVin || "none",
    condition: condition || "none",
    message: message || "",
    source: normalizedSource,
  });
}

async function createAutomationBotJunkCarRequest(body, userId) {
  const { name, email, phone, year, make, model, engineOrVin, condition, source, message } = body;
  const parsedYear = parseYear(year);

  const rawSource = source?.toString().trim().toLowerCase();
  const resolvedSource = SOURCE_MAP[rawSource] || "other";

  return junkCarRepository.create({
    name: name || "none",
    email: email || "none",
    phone: phone || "none",
    year: parsedYear,
    make: make || "none",
    model: model || "none",
    engineOrVin: engineOrVin || "none",
    condition: condition || "none",
    message: message || "",
    source: resolvedSource,
    createdBy: userId,
  });
}

async function getAllJunkCars(userRole) {
  const filter = {};
  if (userRole === "staff") {
    filter.movedToIntake = { $ne: true };
  }

  const data = await junkCarRepository
    .find(filter)
    .populate("assignedTo", "first_name last_name email role")
    .populate("createdBy", "first_name last_name email role");

  console.log(JSON.stringify(data, null, 2)); // added by shiva — the temp debug

  const statusOrder = {
    pending: 1,
    "in progress": 2,
    completed: 3,
  };

  data.sort((a, b) => {
    const statusDiff =
      (statusOrder[a.status?.toLowerCase()] || 99) -
      (statusOrder[b.status?.toLowerCase()] || 99);

    if (statusDiff !== 0) {
      return statusDiff;
    }

    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  return data;
}

async function updateJunkCarRemark(id, remark) {
  return junkCarRepository.findByIdAndUpdate(id, { remark }, { new: true });
}

/**
 * Shared side-effect: when a Junk Car request transitions to
 * completed+paid, auto-create a CarIntake record (unless a matching VIN
 * already exists) and flag the JunkCar as moved. `fallbackVinSuffix` mirrors
 * the two original call sites exactly — updateJunkCarStatus used
 * `JUNK${updated._id}`, updateJunkCarPaymentStatus used `JUNK${Date.now()}` —
 * a pre-existing inconsistency preserved verbatim, not "fixed".
 */
async function maybeCreateCarIntakeFromJunkCar(updated, fallbackVinSuffix) {
  if (
    updated &&
    updated.status &&
    updated.status.toLowerCase() === "completed" &&
    updated.paymentStatus !== "Not Paid"
  ) {
    const vinValue =
      updated.engineOrVin && updated.engineOrVin !== "none" && updated.engineOrVin.trim().length > 5
        ? updated.engineOrVin.toUpperCase()
        : fallbackVinSuffix;

    const existing = await carIntakeRepository.findOne({ vin: vinValue });

    if (!existing) {
      await carIntakeRepository.create({
        vin: vinValue,
        carDetails: {
          year: updated.year || null,
          make: updated.make || "",
          model: updated.model || "",
          trim: "Junk Car",
          description: "Auto added from Junk Car Request",
        },
        status: "intake",
      });

      await junkCarRepository.findByIdAndUpdate(updated._id, { movedToIntake: true });

      console.log("Car Intake Created Successfully ✅");
    } else {
      console.log("Duplicate VIN - Skipped");
    }
  }
}

async function updateJunkCarStatus(id, status, userId) {
  const updated = await junkCarRepository.findByIdAndUpdate(
    { _id: id },
    { $set: { status, assignedTo: userId } },
    { new: true }
  );

  await maybeCreateCarIntakeFromJunkCar(updated, `JUNK${updated?._id}`);

  return updated;
}

async function updateJunkCarSource(id, source) {
  const rawSource = source?.toString().trim().toLowerCase();
  const normalizedSource = SOURCE_MAP[rawSource] || "other";

  return junkCarRepository.findByIdAndUpdate(
    { _id: id },
    { $set: { source: normalizedSource } },
    { new: true }
  );
}

async function updateJunkCarPaymentStatus(id, paymentStatus, userId) {
  const updated = await junkCarRepository.findByIdAndUpdate(
    { _id: id },
    { $set: { paymentStatus, assignedTo: userId } },
    { new: true }
  );

  await maybeCreateCarIntakeFromJunkCar(updated, `JUNK${Date.now()}`);

  return updated;
}

async function assignJunkCarStaff(id, assignedTo) {
  return junkCarRepository
    .findByIdAndUpdate(id, { assignedTo }, { new: true })
    .populate("assignedTo", "first_name last_name email role");
}

module.exports = {
  createJunkCarRequest,
  createAutomationBotJunkCarRequest,
  getAllJunkCars,
  updateJunkCarRemark,
  updateJunkCarStatus,
  updateJunkCarSource,
  updateJunkCarPaymentStatus,
  assignJunkCarStaff,
};
