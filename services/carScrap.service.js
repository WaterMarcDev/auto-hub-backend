/**
 * Car scrap workflow.
 *
 *   Car Inventory for Scrap ──(admin/manager: Send to Ready To Scrap)──▶ ready-to-scrap
 *   Ready To Scrap ──(scraper/admin: Move To Scrapped + Extract Elements)──▶ scraped
 *
 * Moving to scrapped records the extracted elements (ScrapElement + Element
 * Hub stock) and, optionally, takes the car's parts that went to the crusher
 * out of inventory. Parts that were pulled from the car stay in inventory.
 *
 * Removed parts are soft-deleted with removedReason "car-scrapped" so they
 * stay visible on the car's scrap details. Their eBay/Wix listings are NOT
 * ended automatically — the details endpoint flags them for manual removal.
 */
const mongoose = require("mongoose");
const CarIntake = require("../models/CarIntake.model");
const Inventory = require("../models/Inventory.model");
const ScrapElement = require("../models/ScrapElement.model");
const { addToHubInternal } = require("../controllers/elementHub.controller");

const READY_TO_SCRAP_FROM = ["payment-done", "part-added-to-inventory"];
const PART_REMOVED_REASON = "car-scrapped";
const MAX_ELEMENTS = 100;

class ScrapFlowError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizeVin = (vin) => String(vin || "").trim().toUpperCase();
const vinFilter = (vin) => ({ vin: new RegExp(`^\\s*${escapeRegex(normalizeVin(vin))}\\s*$`, "i") });

function assertObjectId(id, label = "car") {
  if (!mongoose.isValidObjectId(id)) throw new ScrapFlowError(404, `${label} not found`);
}

/**
 * Validate the extracted elements sent by the popup.
 * @returns {Array<{elementName, unit, weight, quality, dimensions}>}
 */
function parseElements(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ScrapFlowError(400, "Select at least one extracted element.");
  }
  if (raw.length > MAX_ELEMENTS) throw new ScrapFlowError(400, `At most ${MAX_ELEMENTS} elements can be saved at once.`);

  return raw.map((el, i) => {
    const elementName = String(el?.elementName ?? "").trim();
    const weight = Number(el?.weight);
    const unit = el?.unit === undefined || el?.unit === null || el?.unit === "" ? 1 : Number(el.unit);
    if (!elementName || elementName.length > 100) throw new ScrapFlowError(400, `Element #${i + 1}: name is required.`);
    if (!Number.isFinite(weight) || weight <= 0) throw new ScrapFlowError(400, `Element "${elementName}": weight must be greater than 0.`);
    if (!Number.isInteger(unit) || unit < 1) throw new ScrapFlowError(400, `Element "${elementName}": unit must be a whole number of at least 1.`);
    return {
      elementName,
      unit,
      weight,
      quality: el?.quality ? String(el.quality).trim().slice(0, 100) : undefined,
      dimensions: el?.dimensions ? String(el.dimensions).trim().slice(0, 100) : undefined,
    };
  });
}

/** Inventory ids (of this car, still active) that went to the crusher. */
async function resolvePartsToRemove(car, rawIds) {
  if (rawIds === undefined || rawIds === null) return [];
  if (!Array.isArray(rawIds)) throw new ScrapFlowError(400, "removePartIds must be an array.");
  const ids = [...new Set(rawIds.map(String))];
  if (ids.length === 0) return [];
  if (!ids.every((id) => mongoose.isValidObjectId(id))) throw new ScrapFlowError(400, "removePartIds contains an invalid id.");

  const found = await Inventory.find({ _id: { $in: ids }, ...vinFilter(car.vin), isDeleted: { $ne: true } }).select("_id").lean();
  if (found.length !== ids.length) throw new ScrapFlowError(400, "Some selected parts do not belong to this car or were already removed.");
  return ids;
}

async function loadCar(carId) {
  assertObjectId(carId);
  const car = await CarIntake.findOne({ _id: carId, isDeleted: { $ne: true } });
  if (!car) throw new ScrapFlowError(404, "Car not found");
  return car;
}

/** Save elements + add their weight to Element Hub stock. Returns saved docs. */
async function saveElements(car, elements, userId) {
  const vin = normalizeVin(car.vin);
  const saved = await ScrapElement.insertMany(elements.map((el) => ({ ...el, vin })));

  for (const el of saved) {
    try {
      await addToHubInternal({ elementName: el.elementName, amount: el.weight, sourceVin: vin, createdBy: userId });
    } catch (err) {
      // Same policy as the single-element endpoint: stock update is logged, never blocks.
      console.error(`[SCRAP] Element Hub update failed for ${el.elementName} (${vin}):`, err.message);
    }
  }
  return saved;
}

async function removeParts(partIds, userId) {
  if (!partIds.length) return 0;
  const result = await Inventory.updateMany(
    { _id: { $in: partIds }, isDeleted: { $ne: true } },
    { $set: { isDeleted: true, deletedAt: new Date(), removedReason: PART_REMOVED_REASON, removedBy: userId || null } }
  );
  return result.modifiedCount || 0;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Car Inventory for Scrap → Ready To Scrap (admin/manager). */
async function sendToReadyToScrap(carId) {
  const car = await loadCar(carId);
  if (!READY_TO_SCRAP_FROM.includes(car.status)) {
    throw new ScrapFlowError(409, `Only cars in ${READY_TO_SCRAP_FROM.join(" / ")} can be sent to Ready To Scrap (current: ${car.status || "intake"}).`);
  }
  const updated = await CarIntake.findOneAndUpdate(
    { _id: car._id, status: { $in: READY_TO_SCRAP_FROM } },
    { $set: { status: "ready-to-scrap" } },
    { new: true }
  );
  if (!updated) throw new ScrapFlowError(409, "The car's status changed — refresh and try again.");
  return updated;
}

/**
 * Ready To Scrap → Scrapped with extracted elements (scraper/admin).
 * The status is claimed first (ready-to-scrap → scraped) so a double click
 * can't save elements twice; if saving elements fails the claim is undone.
 */
async function moveToScrapped(carId, { elements: rawElements, scrapRemarks, removePartIds }, userId) {
  const elements = parseElements(rawElements);
  const car = await loadCar(carId);
  if (car.status !== "ready-to-scrap") {
    throw new ScrapFlowError(409, `Only Ready To Scrap cars can be moved to Scrapped (current: ${car.status || "intake"}).`);
  }
  const partIds = await resolvePartsToRemove(car, removePartIds);

  const claimed = await CarIntake.findOneAndUpdate(
    { _id: car._id, status: "ready-to-scrap" },
    {
      $set: {
        status: "scraped",
        scrapedBy: userId,
        scrapDate: new Date(),
        scrapRemarks: typeof scrapRemarks === "string" ? scrapRemarks.trim().slice(0, 2000) : "",
      },
    },
    { new: true }
  );
  if (!claimed) throw new ScrapFlowError(409, "This car was already moved — refresh the list.");

  let saved;
  try {
    saved = await saveElements(claimed, elements, userId);
  } catch (err) {
    await CarIntake.updateOne(
      { _id: car._id, status: "scraped" },
      { $set: { status: "ready-to-scrap" }, $unset: { scrapedBy: "", scrapDate: "", scrapRemarks: "" } }
    );
    throw err;
  }

  const removedParts = await removeParts(partIds, userId);
  return { car: claimed, elements: saved, removedParts };
}

/** Backfill elements for a car scrapped without any (scraper/admin). */
async function addElementsToScrappedCar(carId, { elements: rawElements, removePartIds }, userId) {
  const elements = parseElements(rawElements);
  const car = await loadCar(carId);
  if (car.status !== "scraped") throw new ScrapFlowError(409, "Elements can only be added to scrapped cars.");
  if (await ScrapElement.exists({ vin: normalizeVin(car.vin), isDeleted: { $ne: true } })) {
    throw new ScrapFlowError(409, "This car already has extracted elements.");
  }
  const partIds = await resolvePartsToRemove(car, removePartIds);

  const saved = await saveElements(car, elements, userId);
  const removedParts = await removeParts(partIds, userId);
  return { car, elements: saved, removedParts };
}

/** Elements + parts kept in inventory + parts removed with the car. */
async function getScrapDetails(carId) {
  const car = await loadCar(carId);
  const vin = normalizeVin(car.vin);

  const [elements, parts] = await Promise.all([
    ScrapElement.find({ vin, isDeleted: { $ne: true } }).sort({ createdAt: 1 }).lean(),
    Inventory.find(vinFilter(car.vin))
      .select("partName sku category ebayListingId ebaySyncStatus wixProductId wixSynced isDeleted deletedAt removedReason")
      .sort({ partName: 1 })
      .lean(),
  ]);

  const toPart = (p) => ({
    _id: p._id,
    partName: p.partName,
    sku: p.sku || null,
    ebayListingId: p.ebayListingId || null,
    ebaySyncStatus: p.ebaySyncStatus || null,
    wixProductId: p.wixProductId || null,
    removedAt: p.deletedAt || null,
  });

  const keptParts = parts.filter((p) => !p.isDeleted).map(toPart);
  const removedParts = parts
    .filter((p) => p.isDeleted && p.removedReason === PART_REMOVED_REASON)
    .map((p) => ({ ...toPart(p), pendingExternalRemoval: Boolean(p.ebayListingId || p.wixProductId) }));

  return {
    car: {
      _id: car._id,
      vin: car.vin,
      status: car.status,
      year: car.carDetails?.year,
      make: car.carDetails?.make,
      model: car.carDetails?.model,
      scrapDate: car.scrapDate || null,
      scrapRemarks: car.scrapRemarks || "",
    },
    elements,
    keptParts,
    removedParts,
  };
}

module.exports = {
  READY_TO_SCRAP_FROM,
  PART_REMOVED_REASON,
  ScrapFlowError,
  sendToReadyToScrap,
  moveToScrapped,
  addElementsToScrappedCar,
  getScrapDetails,
  parseElements,
};
