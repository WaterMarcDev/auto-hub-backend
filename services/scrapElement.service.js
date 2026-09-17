/**
 * Scrap element (per-VIN salvaged material record) business logic.
 * Extracted 1:1 from controllers/ScrapElement.controller.js during the
 * clean-architecture migration.
 *
 * NOTE: this domain calls into `controllers/elementHub.controller.js`
 * (addToHubInternal) directly — a pre-existing controller-to-controller
 * dependency. elementHub is being migrated separately in this same overall
 * effort; this require is preserved exactly as-is (not routed through a
 * elementHub service/repository) to avoid coupling this batch's correctness
 * to work happening in a different batch. Once elementHub's own service
 * layer exists, this call can be pointed at it instead.
 */
const scrapElementRepository = require("../repositories/scrapElement.repository");
const elementHubController = require("../controllers/elementHub.controller");

function validationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function createScrapElement({ elementName, unit, quality, weight, dimensions, vin }, createdBy) {
  if (!elementName || vin == null || vin === "") {
    throw validationError("Element name and VIN are required.");
  }

  const vinString = String(vin).trim().toUpperCase();

  const newScrapElement = new (scrapElementRepository.raw())({
    elementName: String(elementName).trim(),
    unit: unit,
    quality: quality ? String(quality).trim() : undefined,
    weight: weight,
    dimensions: dimensions ? String(dimensions).trim() : undefined,
    vin: vinString,
  });

  const savedElement = await scrapElementRepository.save(newScrapElement);

  try {
    if (savedElement.weight && savedElement.weight > 0) {
      await elementHubController.addToHubInternal({
        elementName: savedElement.elementName,
        amount: savedElement.weight,
        unit: savedElement.unit,
        sourceVin: savedElement.vin,
        createdBy,
      });
    }
  } catch (err) {
    console.error("Failed to update element hub after scrap create:", err);
    // don't block the main response; just log
  }

  return savedElement;
}

async function getScrapElementsByVIN(vin) {
  const vinQuery = String(vin).trim().toUpperCase();
  return scrapElementRepository.find({ vin: vinQuery });
}

module.exports = {
  createScrapElement,
  getScrapElementsByVIN,
};
