/**
 * Vehicle Manufacturer Classification (German vs Standard)
 *
 * Classifies a vehicle's pricing category using its manufacturer/make — the
 * same Make already resolved on every Inventory item. That value is not
 * re-derived here: Inventory.make is a required reference set at inventory
 * creation time, and for VIN-decoded intakes it is originally populated from
 * the NHTSA VIN decoder's own `Make` field (see controllers/vinController.js
 * and jobs/fetchVinDetailsJob.js, which map `vinDetails.Make` into
 * carDetails.make). By the time Part Syncing runs, controllers/wix.js
 * already reads this as `item.make.name` for brand/slug/description — this
 * module classifies that same value, so no new VIN decoding or external API
 * call is introduced.
 *
 * Classification is by manufacturer identity ONLY — never by VIN plant/
 * assembly-country data. A German-badged vehicle assembled outside Germany
 * (or a non-German brand assembled inside Germany) must still classify by
 * brand, not factory location.
 *
 * No existing backend source marks a Make as "German" — verified:
 * models/Make.js has no country/type field, and no configuration or
 * business rule exists anywhere else in this codebase. This list is the
 * smallest backend-only mapping that makes the classification possible,
 * centralized in one place. It reflects publicly-known German vehicle
 * manufacturers/brands; extend the list below (never the matching logic,
 * never scattered per-controller checks) if the business adds a Make that
 * should also count.
 */
const GERMAN_MANUFACTURERS = [
  "BMW",
  "MINI",
  "MERCEDES-BENZ",
  "MERCEDES BENZ",
  "MERCEDES",
  "AUDI",
  "VOLKSWAGEN",
  "VW",
  "PORSCHE",
  "OPEL",
  "SMART",
  "MAYBACH",
];

const GERMAN_MANUFACTURER_SET = new Set(
  GERMAN_MANUFACTURERS.map((name) => name.toUpperCase().trim())
);

/**
 * @param {string|null|undefined} makeName - resolved manufacturer/make name (e.g. item.make?.name)
 * @returns {boolean} true if this manufacturer is classified as German for pricing purposes
 */
function isGermanVehicle(makeName) {
  if (!makeName || typeof makeName !== "string") return false;
  return GERMAN_MANUFACTURER_SET.has(makeName.toUpperCase().trim());
}

module.exports = { isGermanVehicle, GERMAN_MANUFACTURERS };
