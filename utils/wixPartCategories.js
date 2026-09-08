/**
 * Canonical Wix part-category mapping.
 *
 * Mongo Inventory.category is source data and may legitimately be
 * "Uncategorized". Wix category/collection assignment is determined
 * from the canonical partName.
 */

const PART_CATEGORY_MAP = {
  acCompressor: "ENGINE",
  airIntakeManifold: "ENGINE",
  alternator: "ENGINE",

  baseChassisPlate: "CHASSIS",
  chassis: "CHASSIS",

  battery: "Electrical Parts",
  fuseBox: "Electrical Parts",
  odometer: "Electrical Parts",
  windowSwitches: "Electrical Parts",
  wiringHarness: "Electrical Parts",

  brakeDisk: "BRAKING",
  brakeDrum: "BRAKING",

  coPassengerSeat: "Interior Parts",
  dashboard: "Interior Parts",
  driverSeat: "Interior Parts",
  floorCarpet: "Interior Parts",
  footRest: "Interior Parts",
  heatedSeats: "Interior Parts",
  heatedSteering: "Interior Parts",
  rearBackSeat: "Interior Parts",
  steering: "Interior Parts",

  heatedSideMirrors: "Exterior Parts",
  leftHeadlights: "Exterior Parts",
  leftSideMirror: "Exterior Parts",
  rightHeadlights: "Exterior Parts",
  rightSideMirror: "Exterior Parts",
  heatedRearWindShield: "Exterior Parts",
  heatedWindshield: "Exterior Parts",

  frontBumper: "Vehicle Body Parts",
  frontLeftDoor: "Vehicle Body Parts",
  frontRightDoor: "Vehicle Body Parts",
  hood: "Vehicle Body Parts",
  latches: "Vehicle Body Parts",
  leftFender: "Vehicle Body Parts",
  rearBumper: "Vehicle Body Parts",
  rearLeftDoor: "Vehicle Body Parts",
  rearRightDoor: "Vehicle Body Parts",
  rightFender: "Vehicle Body Parts",
  trunkGate: "Vehicle Body Parts",

  coolantReservoir: "ENGINE",
  engine: "ENGINE",
  engineControlModule: "ENGINE",
  fuelPump: "ENGINE",
  fuelTank: "ENGINE",
  radiator: "ENGINE",

  rims: "Wheels & Rims",
  tire: "Wheels & Rims",

  transmission: "TRANSMISSION"
};

function resolveWixPartCategory(partName, fallback = "Uncategorized") {
  const key = String(partName || "").trim();
  return PART_CATEGORY_MAP[key] || fallback;
}

module.exports = {
  PART_CATEGORY_MAP,
  resolveWixPartCategory,
};
