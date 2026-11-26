const Make = require("../models/Make.model");
const CarModel = require("../models/CarModel.model");
const Trim = require("../models/Trim.model");
const Inventory = require("../models/Inventory.model");
const Part = require("../models/Part.model");
const CarIntake = require("../models/CarIntake.model");
const Tag = require("../models/Tag.model");
const { isWixExcludedPart } = require("../utils/wixExportExclusions");
const { removedPartsNor, isRemovedPart } = require("../utils/removedParts");
const { resolvePartPrice } = require("../utils/partPricing");
const { isGermanVehicle } = require("../utils/vehicleClassification");
const {
  toTitleFromCamelCase,
  buildCaseInsensitiveNameQuery,
} = require("../utils/productIdentity");


const mongoose = require("mongoose");
const {
  TEXT_LIMITS,
  isBlank,
  optionalText,
  parseWeight,
  parseVin,
  parseYear,
  parseColor,
  isInputError,
} = require("../utils/inventoryFieldRules");

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Resolves a Make document by name, case-insensitively (e.g. "toyota",
 * "TOYOTA", and "Toyota" all resolve to the same existing "Toyota"
 * document instead of each falling through to createInventory's
 * create-if-missing fallback and producing duplicate Make records that
 * differ only in casing). Read-only — never mutates existing Make
 * documents; a caller deciding to create a new Make on a miss is
 * unaffected by this helper.
 */
async function findMakeByNameCaseInsensitive(rawName) {
  if (!rawName) return null;
  return Make.findOne(buildCaseInsensitiveNameQuery(rawName));
}

/**
 * Asset tags link to inventory one way (Tag.inventoryId → Inventory). Returns
 * a Map of inventory id (string) → tag code (e.g. "AUT000123") for the given
 * inventory ids, so list endpoints can show each part's asset tag.
 */
async function getAssetTagMap(inventoryIds) {
  const ids = (inventoryIds || []).filter(Boolean);
  if (!ids.length) return new Map();
  const tags = await Tag.find({ inventoryId: { $in: ids } })
    .select("inventoryId barcodeString")
    .lean();
  return new Map(tags.map((t) => [String(t.inventoryId), t.barcodeString]));
}

const generateShortName = (name) => {
  if (!name) return "";
  const parts = name.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 1) {
    const word = parts[0];
    if (word.length <= 3) {
      return word.toUpperCase();
    }
    return word.slice(0, 2).toUpperCase();
  }

  // more than one word: use initial letter of every word
  return parts.map((w) => w.charAt(0).toUpperCase()).join("");
};

const createInventory = async (req, res) => {
  try {
    let { make, model, trim, partName } = req.body;
    const { unit, cleaned, otherPart, image, price, remarks } = req.body;
    const {
      location: rawLocation,
      weight: rawWeight,
      dimensions: rawDimensions,
      vin: rawVin,
      year: rawYear,
      color: rawColor,
      quality: rawQuality,
    } = req.body;

    // Parts removed from the CRM (A1, A2, windshields: utils/removedParts.js).
    if (isRemovedPart(partName)) {
      return res
        .status(400)
        .json({ message: `${partName} has been removed from the CRM and cannot be added to inventory` });
    }

    // Unit: whole number, digits only.
    if (!/^\d+$/.test(String(unit ?? "").trim())) {
      return res.status(400).json({ message: "Unit must contain digits only" });
    }

    // Optional fields: trimmed, blank / spaces-only stored as empty, length
    // limits, and weight / VIN / year checked so bad input is a 400, not a 500.
    // Bulk adds (Add To Inventory page) take VIN and year from the car
    // intake record, so those two are not re-validated there.
    const fieldError = (r) => (r.error ? res.status(400).json({ message: r.error }) : null);
    const partNameR = optionalText(partName, "Part name", TEXT_LIMITS.partName);
    if (partNameR.error) return fieldError(partNameR);
    if (!partNameR.value) return res.status(400).json({ message: "Part name is required" });
    partName = partNameR.value;
    const locationR = optionalText(rawLocation, "Location", TEXT_LIMITS.location);
    const dimensionsR = optionalText(rawDimensions, "Dimensions", TEXT_LIMITS.dimensions);
    // Manual add: letters, spaces and hyphens only. Bulk add takes the color
    // from the car intake record (e.g. "N/A", "Silver/Grey"), so only the
    // length is checked there.
    const colorR = req.fromBulk
      ? optionalText(rawColor, "Color", TEXT_LIMITS.color)
      : parseColor(rawColor);
    const qualityR = optionalText(rawQuality, "Quality", TEXT_LIMITS.quality);
    const weightR = parseWeight(rawWeight);
    for (const r of [locationR, dimensionsR, colorR, qualityR, weightR]) {
      if (r.error) return fieldError(r);
    }
    let cleanVin = isBlank(rawVin) ? undefined : String(rawVin).trim();
    let cleanYear = isBlank(rawYear) ? undefined : rawYear;
    if (!req.fromBulk) {
      const vinR = parseVin(rawVin);
      const yearR = parseYear(rawYear);
      if (vinR.error) return fieldError(vinR);
      if (yearR.error) return fieldError(yearR);
      cleanVin = vinR.value;
      cleanYear = yearR.value;
    }
    const location = locationR.value;
    const dimensions = dimensionsR.value;
    const color = colorR.value;
    const quality = qualityR.value;
    const weight = weightR.value;
    const vin = cleanVin;
    const year = cleanYear;

    // "Other" parts are typed in by hand and may not be identifiable: a
    // blank Make / Model / Trim is stored as "Unknown" instead of being
    // required (the inventory record still needs all three references).
    if (otherPart === true || otherPart === "true") {
      const makeR = optionalText(make, "Make", TEXT_LIMITS.vehicleName);
      const modelR = optionalText(model, "Model", TEXT_LIMITS.vehicleName);
      const trimR = optionalText(trim, "Trim", TEXT_LIMITS.vehicleName);
      for (const r of [makeR, modelR, trimR]) {
        if (r.error) return fieldError(r);
      }
      make = makeR.value || "Unknown";
      model = modelR.value || "Unknown";
      trim = trimR.value || "Unknown";
    }

    // Duplicate VIN rule: one car (VIN) has many parts, so the same VIN is
    // allowed on different parts; the same part twice for one VIN is not.
    if (vin) {
      const duplicate = await Inventory.findOne({
        // Same VIN in any letter case.
        vin: new RegExp(`^${escapeRegex(vin)}$`, "i"),
        partName: new RegExp(`^${escapeRegex(partName)}$`, "i"),
        isDeleted: { $ne: true },
      })
        .select("_id")
        .lean();
      if (duplicate) {
        return res
          .status(409)
          .json({ message: `${partName} is already in inventory for VIN ${vin}` });
      }
    }

    // Optional free-text remarks (used e.g. for "Other" parts).
    const cleanRemarks =
      typeof remarks === "string" && remarks.trim() ? remarks.trim().slice(0, 2000) : undefined;

    // Optional: reject invalid values, coerce blank/omitted to null.
    let parsedPrice = null;
    if (price !== undefined && price !== null && price !== "") {
      const numericPrice = Number(price);
      if (Number.isNaN(numericPrice) || numericPrice < 0) {
        return res
          .status(400)
          .json({ success: false, message: "Price must be a non-negative number" });
      }
      parsedPrice = numericPrice;
    }

    // Resolve Make: accept ObjectId or name
    let makeDoc = null;
    let makeId = null;
    if (make && mongoose.Types.ObjectId.isValid(make)) {
      makeDoc = await Make.findById(make);
      if (makeDoc) makeId = makeDoc._1d || makeDoc._id;
    }
    if (!makeDoc && make) {
      // Case-insensitive: "toyota"/"TOYOTA"/"Toyota" all resolve to the
      // same existing Make document instead of each creating a new,
      // differently-cased duplicate below.
      makeDoc = await findMakeByNameCaseInsensitive(make);
    }
    if (!makeDoc && make) {
      makeDoc = await Make.create({
        name: make,
        shortName: generateShortName(make),
      });
    }
    if (makeDoc) makeId = makeDoc._id;

    // Resolve Model: accept ObjectId or name; if model is id but make not provided, derive make from model
    let modelDoc = null;
    let modelId = null;
    if (model && mongoose.Types.ObjectId.isValid(model)) {
      modelDoc = await CarModel.findById(model);
      if (modelDoc && !makeId && modelDoc.make) {
        const derivedMake = await Make.findById(modelDoc.make);
        if (derivedMake) {
          makeDoc = derivedMake;
          makeId = derivedMake._id;
        }
      }
    }
    if (!modelDoc && model) {
      modelDoc = await CarModel.findOne({ name: model, make: makeId });
    }
    if (!modelDoc && model) {
      modelDoc = await CarModel.create({
        name: model,
        make: makeId,
        shortName: generateShortName(model),
      });
    }
    if (modelDoc) modelId = modelDoc._id;

    // Resolve Trim: accept ObjectId or name; if trim provided as id, ensure we have model/make
    let trimDoc = null;
    let trimId = null;
    if (trim && mongoose.Types.ObjectId.isValid(trim)) {
      trimDoc = await Trim.findById(trim);
      if (trimDoc) {
        if (!modelId && trimDoc.model) {
          const derivedModel = await CarModel.findById(trimDoc.model);
          if (derivedModel) {
            modelDoc = derivedModel;
            modelId = derivedModel._id;
            if (!makeId && derivedModel.make) {
              const derivedMake = await Make.findById(derivedModel.make);
              if (derivedMake) {
                makeDoc = derivedMake;
                makeId = derivedMake._id;
              }
            }
          }
        }
      }
    }
    if (!trimDoc && trim) {
      trimDoc = await Trim.findOne({ name: trim, model: modelId });
    }
    if (!trimDoc && trim) {
      trimDoc = await Trim.create({
        name: trim,
        make: makeId,
        model: modelId,
        shortName: generateShortName(trim),
      });
    }
    if (trimDoc) trimId = trimDoc._id;

    // Resolve partShortName server-side. Prefer an existing Part.shortName, fall back to name, else generate.
    let resolvedPartShort = "";
    
    // Resolves resolvedPartShort : added by shiva
    let category = "Uncategorized";

    try {
      const partDoc = await Part.findOne({
        name: new RegExp(`^${escapeRegex(partName)}$`, "i"),
      });

      console.log("PART LOOKUP:", partName, JSON.stringify(partDoc, null, 2));

      if (partDoc?.category) {
        category = partDoc.category;
      }
    } catch (e) {
      console.log("Category lookup failed:", e);
    }
    // end here

    let partDoc =  null; //(await Part.findOne({ shortName: partName })) || null;   //added by shiva
    try {
      if (partName) {
        // Try exact shortName match first
        if (!partDoc) {
          // Try by name (case-insensitive)
          partDoc = await Part.findOne({
            name: new RegExp(`^${escapeRegex(partName)}$`, "i"),
          });
        }
        if (partDoc && partDoc.shortName) {
          resolvedPartShort = partDoc.shortName;
        }
      }
    } catch (e) {
      // ignore lookup errors and fall back to generation
    }

    if (!resolvedPartShort) {
      resolvedPartShort = generateShortName(partName || "");
    }

    const partCategory = partDoc?.category || "Uncategorized";   // added by shiva

    // Added by shiva fix SKU template literal bug
    const makeShort = (makeDoc && makeDoc.shortName) || "";
    const modelShort = (modelDoc && modelDoc.shortName) || "";
    const sku = `${makeShort}/${modelShort}/${year || ""}-${resolvedPartShort}/${color || ""}`;
    // end here

    // const sku = `${(makeDoc && makeDoc.shortName) || ""}/${(modelDoc && modelDoc.shortName) || ""
    //   }/${year || ""}-${resolvedPartShort}/${color || ""}`;

    // Prevent duplicate inventory records by checking if an identical item already exists
    // const existingInventory = await Inventory.findOne({
    //   vin,
    //   partName: { $regex: new RegExp(`^${partName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, "i") },
    //   // make: makeId,
    //   // model: modelId,
    //   // trim: trimId,
    //   // year,
    // });

    // if (existingInventory) {
    //   return res.status(200).json({
    //     message: "Inventory item already exists",
    //     data: existingInventory,
    //   });
    // }

    const inventory = await Inventory.create({
      partName,
      category: partCategory,   //added by shiva
      unit,
      cleaned: cleaned || false,
      quality,
      location,
      weight,
      dimensions,
      make: makeId,
      model: modelId,
      trim: trimId,
      vin,
      sku,
      year,
      color,
      image: image || null,
      price: parsedPrice,
      ...(cleanRemarks ? { remarks: cleanRemarks } : {}),
    });

    res
      .status(201)
      .json({ message: "Inventory created successfully", data: inventory });
  } catch (error) {
    // Unique index { vin, partName }: the same part twice for one VIN (or
    // twice with no VIN) is a duplicate, not a server error.
    if (error?.code === 11000) {
      const label = String(req.body?.partName || "This part").trim();
      return res.status(409).json({
        message: isBlank(req.body?.vin)
          ? `${label} is already in inventory without a VIN. Enter the car's VIN to add it again.`
          : `${label} is already in inventory for this VIN`,
      });
    }
    if (isInputError(error)) {
      return res.status(400).json({ message: `Invalid inventory data: ${error.message}` });
    }
    console.error("Error creating inventory:", error);
    res.status(500).json({ message: "Server error while creating inventory" });
  }
};

// Runs the real createInventory handler for one part without an HTTP round
// trip (same pattern as scripts/bulkAddCarsToInventory.js), so every part
// created in bulk goes through exactly the same validation, Make/Model/Trim
// resolution, SKU, category and price handling as a single create.
const createInventoryInternal = async (body) => {
  let statusCode = 200;
  let payload = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      payload = data;
      return this;
    },
  };
  // fromBulk: VIN and year come from the car intake record (not re-validated).
  await createInventory({ body, fromBulk: true }, res);
  return { statusCode, payload };
};

const BULK_INVENTORY_MAX_PARTS = 200;

// Key of a catalog part in an intake's partDetails.parts ("Front Bumper" ->
// "frontBumper"), as the Car Intake Step 3 table (CarDiagnosis.jsx) saves it.
const intakePartKey = (name) => {
  const words = String(name || "")
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "";
  return (
    words[0].toLowerCase() +
    words
      .slice(1)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join("")
  );
};

// Highest unit Add To Inventory may use for each part of a car intake: the
// unit recorded for that part at Car Intake (Step 3 already caps it at the
// catalog unit). A part with no recorded unit (blank / 0) is capped at the
// catalog part's unit; with neither there is no cap.
// Returns Map(partName -> max).
const intakeUnitCaps = async (carIntake, partNames) => {
  const caps = new Map();
  if (!carIntake) return caps;
  const intakeParts = carIntake.partDetails?.parts || {};
  let catalog = null;
  for (const name of partNames) {
    const recorded = Number(intakeParts[name]?.unit);
    if (Number.isFinite(recorded) && recorded > 0) {
      caps.set(name, recorded);
      continue;
    }
    if (!catalog) {
      catalog = new Map();
      try {
        const list = await Part.find({}).select("name unit").lean();
        for (const p of list || []) {
          const k = intakePartKey(p.name);
          const u = Number(p.unit);
          if (k && !catalog.has(k) && Number.isFinite(u) && u > 0) catalog.set(k, u);
        }
      } catch (e) {
        // no catalog: no cap for parts without a recorded unit
      }
    }
    if (catalog.has(name)) caps.set(name, catalog.get(name));
  }
  return caps;
};

// @desc    Add several parts of one car to inventory in a single request
// @route   POST /api/inventory/bulk
// @access  Private
// Body: { carIntakeId?, vin, make, model, trim, year, color,
//         parts: [{ partName, unit, cleaned, quality, location, weight,
//                   dimensions, image, assetTagId }] }
// Only the parts sent are created (the Add To Inventory page sends the
// ones ticked "Extracted"). Parts already in inventory for the VIN are
// skipped. Each part succeeds or fails on its own. When carIntakeId is
// given and every selected part of that car is now in inventory, the car
// moves to "part-added-to-inventory" — the same rule the page used to apply.
const bulkCreateInventory = async (req, res) => {
  try {
    const { carIntakeId, vin, make, model, trim, year, color, parts } = req.body || {};

    if (typeof vin !== "string" || !vin.trim()) {
      return res.status(400).json({ success: false, message: "VIN is required" });
    }

    if (!Array.isArray(parts) || parts.length === 0) {
      return res.status(400).json({ success: false, message: "At least one part is required" });
    }

    if (parts.length > BULK_INVENTORY_MAX_PARTS) {
      return res.status(400).json({
        success: false,
        message: `A maximum of ${BULK_INVENTORY_MAX_PARTS} parts can be added at once`,
      });
    }

    const invalid = parts.findIndex(
      (p) => !p || typeof p !== "object" || typeof p.partName !== "string" || !p.partName.trim()
    );
    if (invalid !== -1) {
      return res.status(400).json({
        success: false,
        message: `Part ${invalid + 1} is missing a part name`,
      });
    }

    let carIntake = null;
    if (carIntakeId !== undefined && carIntakeId !== null && carIntakeId !== "") {
      if (!mongoose.Types.ObjectId.isValid(carIntakeId)) {
        return res.status(400).json({ success: false, message: "Invalid car intake id" });
      }
      carIntake = await CarIntake.findById(carIntakeId);
      if (!carIntake) {
        return res.status(404).json({ success: false, message: "Car intake not found" });
      }
      if (String(carIntake.vin || "").trim().toUpperCase() !== vin.trim().toUpperCase()) {
        return res.status(400).json({ success: false, message: "VIN does not match the car intake" });
      }
    }

    const existingNames = new Set(
      (await Inventory.find({ vin }).select("partName").lean()).map((i) => i.partName)
    );

    // Unit may not go above what was recorded at Car Intake (QA 077).
    const unitCaps = await intakeUnitCaps(
      carIntake,
      parts.map((p) => p.partName)
    );

    const results = [];
    // One part at a time: createInventory may create a missing Make/Model/
    // Trim, and doing that concurrently could create duplicates.
    for (const part of parts) {
      const partName = part.partName;

      if (existingNames.has(partName)) {
        results.push({ partName, status: "skipped", message: "Already in inventory" });
        continue;
      }

      // A1, A2, Windshield and Heated Windshield are removed from the CRM.
      if (isRemovedPart(partName)) {
        results.push({ partName, status: "skipped", message: "Part removed from the CRM" });
        continue;
      }

      const maxUnit = unitCaps.get(partName);
      if (
        maxUnit !== undefined &&
        /^\d+$/.test(String(part.unit ?? "").trim()) &&
        Number(String(part.unit).trim()) > maxUnit
      ) {
        results.push({
          partName,
          status: "failed",
          message: `Unit cannot be more than ${maxUnit} (recorded at Car Intake)`,
        });
        continue;
      }

      const { statusCode, payload } = await createInventoryInternal({
        partName,
        unit: part.unit,
        cleaned: part.cleaned,
        quality: part.quality,
        location: part.location,
        weight: part.weight,
        dimensions: part.dimensions,
        image: part.image,
        price: part.price,
        make,
        model,
        trim,
        year,
        vin,
        color,
      });

      if (statusCode !== 201 || !payload?.data?._id) {
        results.push({
          partName,
          status: "failed",
          message: payload?.message || "Could not add this part",
        });
        continue;
      }

      existingNames.add(partName);
      const result = { partName, status: "created", inventoryId: payload.data._id };

      // Same update as tag.controller.js#attachTagToPart
      if (part.assetTagId) {
        const tag = await Tag.findOneAndUpdate(
          { barcodeString: part.assetTagId, inventoryId: null },
          { inventoryId: payload.data._id, isUsed: true },
          { new: true }
        );
        if (!tag) result.tagMessage = "Tag already assigned or does not exist";
      }

      results.push(result);
    }

    const count = (status) => results.filter((r) => r.status === status).length;

    let carIntakeStatus = null;
    let stillMissing = [];
    if (carIntake) {
      const intakeParts = carIntake.partDetails?.parts || {};
      // Removed parts (A1, A2, Windshield, Heated Windshield) never go to
      // inventory, so they don't count as missing.
      const selectedKeys = Object.keys(intakeParts).filter(
        (k) => intakeParts[k]?.selected && !isRemovedPart(k)
      );
      const nowInInventory = new Set(
        (await Inventory.find({ vin: carIntake.vin }).select("partName").lean()).map((i) => i.partName)
      );
      stillMissing = selectedKeys.filter((k) => !nowInInventory.has(k));

      if (stillMissing.length === 0 && carIntake.status !== "part-added-to-inventory") {
        const updated = await CarIntake.findByIdAndUpdate(
          carIntake._id,
          { status: "part-added-to-inventory" },
          { new: true }
        );
        carIntakeStatus = updated?.status || null;
      } else {
        carIntakeStatus = carIntake.status;
      }
    }

    res.status(200).json({
      success: count("failed") === 0,
      created: count("created"),
      skipped: count("skipped"),
      failed: count("failed"),
      results,
      carIntakeStatus,
      stillMissing,
    });
  } catch (error) {
    console.error("Bulk create inventory error:", error);
    res.status(500).json({ success: false, message: "Server error while adding parts to inventory" });
  }
};

const getInventoryByVIN = async (req, res) => {
  try {
    const { vin } = req.params;
    const items = await Inventory.find({
      vin,
      $nor: removedPartsNor("partName"),
    })
      .populate("make model trim")
      .lean();
    // Each part's asset tag (shown in the "Barcode" column of View Parts).
    const tagByInventory = await getAssetTagMap(items.map((it) => it._id));
    const inventoryItems = items.map((it) => ({
      ...it,
      barcodeString: tagByInventory.get(String(it._id)) || null,
    }));
    res.status(200).json({ inventoryItems });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Server error while fetching inventory by VIN" });
  }
};

// @desc    Update the manual selling price of a single inventory item
// @route   PATCH /api/inventory/:id/price
// @access  Private
// Deliberately narrow (price only) rather than a generic update endpoint,
// so this cannot be used to change any other inventory field.
const updateInventoryPrice = async (req, res) => {
  try {
    const { id } = req.params;
    const { price } = req.body;

    let parsedPrice = null;
    if (price !== undefined && price !== null && price !== "") {
      const numericPrice = Number(price);
      if (Number.isNaN(numericPrice) || numericPrice < 0) {
        return res
          .status(400)
          .json({ success: false, message: "Price must be a non-negative number" });
      }
      parsedPrice = numericPrice;
    }

    const inventory = await Inventory.findByIdAndUpdate(
      id,
      { price: parsedPrice },
      { new: true }
    );

    if (!inventory) {
      return res.status(404).json({ success: false, message: "Inventory item not found" });
    }

    res.status(200).json({ success: true, inventory });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Server error while updating price" });
  }
};

// @desc    Get all inventory items
// @route   GET /api/inventory
// @access  Private
const getAllInventories = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // A1, A2, Windshield and Heated Windshield are removed from the CRM.
    const filter = { isDeleted: { $ne: true }, $nor: removedPartsNor("partName") };
    if (req.query.make) filter.make = req.query.make;
    if (req.query.model) filter.model = req.query.model;
    if (req.query.trim) filter.trim = req.query.trim;

    if (req.query.search?.trim()) {

      console.log("Search Query:", req.query.search);

      const search = req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      filter.partName = {
        $regex: search,
        $options: "i",
      };
      // filter.partName = { $regex: req.query.search, $options: "i" };
    }

    const total = await Inventory.countDocuments(filter);

    const inventories = await Inventory.find(filter)
      .populate("make")
      .populate("model")
      .populate("trim")
      .skip(skip)
      .limit(limit)
      .sort({ updatedAt: -1 });

    res.status(200).json({
      inventories,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("Get inventories error:", error);
    res.status(500).json({ message: "Server error while fetching inventory" });
  }
};

// Master parts list endpoint (paginated, filtered, reduced fields)
// GET /api/inventory/parts
const getPartsMasterList = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const skip = (page - 1) * limit;

    // A1, A2, Windshield and Heated Windshield are removed from the CRM.
    const filter = {
      isDeleted: { $ne: true },
      $nor: removedPartsNor("partName"),
    };
    if (req.query.make) filter.make = req.query.make;
    if (req.query.model) filter.model = req.query.model;
    if (req.query.trim) filter.trim = req.query.trim;
    if (req.query.cleaned !== undefined) {
      const val = req.query.cleaned;
      if (val === "true" || val === "1") filter.cleaned = true;
      else if (val === "false" || val === "0") filter.cleaned = false;
    }
    if (req.query.quality) filter.quality = req.query.quality;
    // Optional stock filter: "available" (in stock) or "sold" (sold on eBay/Wix).
    // Omitted = all parts, exactly as before.
    if (req.query.saleStatus === "available") filter.saleStatus = { $ne: "sold" };
    else if (req.query.saleStatus === "sold") filter.saleStatus = "sold";
    if (req.query.search?.trim()) {
      
      console.log("Search Query:", req.query.search);

      const search = req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.partName = { $regex: search, $options: "i" };
    }

    console.log("Mongo Filter:", JSON.stringify(filter, null, 2));

    const total = await Inventory.countDocuments(filter);

    const items = await Inventory.find(filter)
      .populate("make", "name shortName")
      .populate("model", "name shortName")
      .populate("trim", "name shortName")
      .select(
        "partName unit cleaned quality location weight dimensions remarks sku year color saleStatus sale.channel sale.orderNumber sale.soldAt sale.assetTag quantityAvailable quantitySold returnInfo.status ebayListingId ebayQuantitySync.status ebayQuantitySync.lastError"
      )
      .skip(skip)
      .limit(limit)
      .sort({ updatedAt: -1 })
      .lean();

    // Asset tags point at the inventory item (Tag.inventoryId).
    const tagByInventory = await getAssetTagMap(items.map((it) => it._id));

    const parts = items.map((it) => ({
      _id: it._id,
      partName: it.partName,
      remarks: it.remarks || "",
      assetTag: tagByInventory.get(String(it._id)) || it.sale?.assetTag || null,
      unit: it.unit,
      cleaned: it.cleaned,
      quality: it.quality,
      location: it.location,
      weight: it.weight,
      dimensions: it.dimensions,
      sku: it.sku,
      year: it.year,
      color: it.color,
      saleStatus: it.saleStatus === "sold" ? "sold" : "available",
      sale: it.sale
        ? { channel: it.sale.channel, orderNumber: it.sale.orderNumber, soldAt: it.sale.soldAt }
        : null,
      // Stock ledger (missing = one physical part)
      quantityAvailable: it.quantityAvailable ?? (it.saleStatus === "sold" ? 0 : 1),
      quantitySold: it.quantitySold ?? 0,
      returnStatus: it.returnInfo?.status || null,
      onEbay: Boolean(it.ebayListingId),
      ebayQuantitySync: it.ebayQuantitySync?.status
        ? { status: it.ebayQuantitySync.status, lastError: it.ebayQuantitySync.lastError || null }
        : null,
      make: it.make ? { _id: it.make._id, name: it.make.name } : null,
      model: it.model ? { _id: it.model._id, name: it.model.name } : null,
      trim: it.trim ? { _id: it.trim._id, name: it.trim.name } : null,
    }));

    res.status(200).json({
      parts,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("Error fetching parts master list:", error);
    res.status(500).json({ message: "Server error while fetching parts" });
  }
};
// Search inventory by Make + Model + Year simultaneously, accepting either
// ObjectIds or human-readable names for make/model (resolved server-side,
// same lookup style as createInventory) so a caller doesn't need separate
// round trips to look up IDs first. Read-only — never creates Make/Model
// records; an unresolvable name just yields zero results.
// GET /api/inventory/search
const searchByMakeModelYear = async (req, res) => {
  try {
    const { make, model, year, partName } = req.query;

    if (!make || !model || !year) {
      return res.status(400).json({
        success: false,
        message: "Make, model, and year are required",
      });
    }
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const skip = (page - 1) * limit;

    const filter = {};

    if (make) {
      // Case-insensitive Make lookup: a caller sending "toyota"/"TOYOTA"
      // must resolve the same existing "Toyota" document that a
      // differently-cased intake channel created, rather than finding no
      // match and returning an empty result for a part that genuinely
      // exists in Inventory.
      const makeDoc = mongoose.Types.ObjectId.isValid(make)
        ? await Make.findById(make)
        : await findMakeByNameCaseInsensitive(make);
      if (!makeDoc) {
        return res.status(200).json({
          parts: [],
          pagination: { page, limit, total: 0, pages: 0 },
        });
      }
      filter.make = makeDoc._id;
    }

    if (model) {
      const modelQuery = { name: model };
      if (filter.make) modelQuery.make = filter.make;
      const modelDoc = mongoose.Types.ObjectId.isValid(model)
        ? await CarModel.findById(model)
        : await CarModel.findOne(modelQuery);
      if (!modelDoc) {
        return res.status(200).json({
          parts: [],
          pagination: { page, limit, total: 0, pages: 0 },
        });
      }
      filter.model = modelDoc._id;
    }

    if (year) {
      const parsedYear = Number(year);
      if (!Number.isNaN(parsedYear)) filter.year = parsedYear;
    }

    if (partName?.trim()) {

      const normalize = (text = "") => 
        String(text)
          .trim()
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .toLowerCase()
          .replace(/[\s_-]+/g, "");

      const normalizedSearch = normalize(partName);

      const parts = await Part.find({}, { name: 1, _id: 0 }).lean();

      const matchedPart = parts.find(part => 
        normalize(part.name) === normalizedSearch);

      if (!matchedPart) {
        return res.status(200).json({
          parts: [],
          pagination: {
            page,
            limit,
            total: 0,
            pages: 0
          }
        });
      }

      const escapedPartName = matchedPart.name.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

      filter.$expr = {
        $eq: [
          {
            $replaceAll: {
              input: {
                $replaceAll: {
                  input: {
                    $replaceAll: {
                      input: { $toLower: "$partName" },
                      find: " ",
                      replacement: ""
                    }
                  },
                  find: "_",
                  replacement: ""
                }
              },
              find: "-",
              replacement: ""
            }
          },
          normalizedSearch
        ]
      };
      
      // filter.partName = {
      //   $regex: `^${escapedPartName}$`,
      //   $options: "i"
      // };
    }
    
    // if (partName?.trim()) {

    //   const normalize = (text) => 
    //     text
    //       .toLowerCase()
    //       .replace(/[\s_-]+/g, "");

    //   const search = normalize(partName);

    //   filter.$expr = {
    //     $ep: [
    //       {
    //         $replaceAll: {
    //           input: {
    //             $toLower: "$partName"
    //           },
    //           find: " ",
    //           replacement: ""
    //         }
    //       },
    //       search
    //     ]
    //   };

    //   console.log("Part Search:", partName);

    //   // const search = partName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    //   // filter.partName = {
    //   //   $regex: search,
    //   //   $options: "i",
    //   // };
    // }

    const total = await Inventory.countDocuments(filter);

    const items = await Inventory.find(filter)
      .populate("make", "name shortName")
      .populate("model", "name shortName")
      .populate("trim", "name shortName")
      .select(
        "partName unit cleaned quality location weight dimensions sku year color price"
      )
      .skip(skip)
      .limit(limit)
      .sort({ updatedAt: -1 })
      .lean();

    const endpoint = items.map((it) => {
      const isGerman = isGermanVehicle(it.make?.name);

      const priceResult = resolvePartPrice({
        partName: it.partName,
        isGerman,
      });

      return {
        make: it.make?.name || "",
        model: it.model?.name || "",
        year: it.year || "",
        partName: it.partName || "",
        urlEndpoint: [
          it.year,
          it.make?.name,
          it.model?.name,
          it.trim?.name,
          toTitleFromCamelCase(it.partName || ""),
        ]
          .filter(Boolean)
          .join("-")
          .toLowerCase()
          .replace(/\s+/g, "-"),
        price: priceResult?.price ?? null,
        condition: it.quality || "",
      };
    });

    res.status(200).json({
      parts: endpoint,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("Error searching inventory by make/model/year:", error);
    res.status(500).json({ message: "Server error while searching inventory" });
  }
};

// Export inventories with custom format
// GET /api/inventory/export
const exportInventories = async (req, res) => {
  try {
    const inventories = await Inventory.aggregate([
      // Join with Make
      {
        $lookup: {
          from: "makes",
          localField: "make",
          foreignField: "_id",
          as: "make",
        },
      },
      { $unwind: { path: "$make", preserveNullAndEmptyArrays: true } },

      // Join with Model
      {
        $lookup: {
          from: "models",
          localField: "model",
          foreignField: "_id",
          as: "model",
        },
      },
      { $unwind: { path: "$model", preserveNullAndEmptyArrays: true } },

      // Join with Trim
      {
        $lookup: {
          from: "trims",
          localField: "trim",
          foreignField: "_id",
          as: "trim",
        },
      },
      { $unwind: { path: "$trim", preserveNullAndEmptyArrays: true } },

      // Join with Tag
      {
        $lookup: {
          from: "tags",
          localField: "_id",
          foreignField: "inventoryId",
          as: "tag",
        },
      },
      { $unwind: { path: "$tag", preserveNullAndEmptyArrays: true } },

      // Join with CarIntake by VIN
      {
        $lookup: {
          from: "carintakes",
          localField: "vin",
          foreignField: "vin",
          as: "carIntake",
        },
      },
      { $unwind: { path: "$carIntake", preserveNullAndEmptyArrays: true } },

      // Raw projection (NO formatting logic here)
      {
        $project: {
          _id: 1,
          year: { $ifNull: ["$year", ""] },
          makeName: { $ifNull: ["$make.name", ""] },
          modelName: { $ifNull: ["$model.name", ""] },
          trimName: { $ifNull: ["$trim.name", ""] },
          partName: { $ifNull: ["$partName", ""] },
          vin: { $ifNull: ["$vin", "N/A"] },
          weight: { $ifNull: ["$weight", 0] },
          sku: { $ifNull: ["$tag.barcodeString", null] },
          // Flatten car details for easier access
          cd: { $ifNull: ["$carIntake.carDetails", {}] },
          vd: { $ifNull: ["$carIntake.vinDetails", {}] },
        },
      },
    ]);

    const formattedInventories = inventories.map(item => {
      const formattedPartName = toTitleFromCamelCase(item.partName);
      const cd = item.cd || {};
      const vd = item.vd || {};

      // Helper to safely get value or N/A. Checks multiple sources.
      const val = (...args) => {
        for (const arg of args) {
          if (arg && arg !== "N/A" && arg !== "") return arg;
        }
        return "N/A";
      };

      const sourceVehicleHtml = `<ul>
	<li>
	<p>Year:${val(item.year, vd.ModelYear)}</p>
	</li>
	<li>
	<p>Make:${val(item.makeName, vd.Make)}</p>
	</li>
	<li>
	<p>Model:${val(item.modelName, vd.Model)}</p>
	</li>
	<li>
	<p>Model Type:${val(item.trimName, vd.Trim)}</p>
	</li>
	<li>
	<p>Body: ${val(cd.bodyClass, vd.BodyClass)}</p>
	</li>
	<li>
	<p>Door Structure:${val(cd.doorCount, vd.Doors)}</p>
	</li>
	<li>
	<p>Cylinders:${val(cd.cylinders, vd.EngineCylinders)}</p>
	</li>
	<li>
	<p>Engine Size:${val(cd.engine, vd.DisplacementL)}</p>
	</li>
	<li>
	<p>Transmission:${val(cd.transmission, vd.TransmissionStyle)}</p>
	</li>
	<li>
	<p>Drive Train:${val(cd.drive, vd.DriveType)}</p>
	</li>
	<li>
	<p>Steering:${val(cd.steering, "POWER")}</p>
	</li>
	<li>
	<p>Brakes:${val(cd.brakes, vd.BrakeSystemType)}</p>
	</li>
	<li>
	<p>ABS:${val(cd.abs, "Y")}</p>
	</li>
	<li>
	<p>Primary Ext Color:${val(cd.color)}</p>
	</li>
	<li>
	<p>Primary Int Color:${val(cd.interiorColor)}</p>
	</li>
	<li>
	<p>Seat Mat:${val(cd.seatMaterial)}</p>
	</li>
	<li>
	<p>Roof Type:${val(cd.roofType)}</p>
	</li>
	<li>
	<p>Win Regulator:${val(cd.windowRegulator)}</p>
	</li>
</ul>
`;

      const description = `${formattedPartName}, Condition: Used, Part Number: 123456789, Year: ${item.year}, Make: ${item.makeName}, Model: ${item.modelName}, Trim: ${item.trimName}, Body: SUV`;

      return {
        // added by shiva
        externalId: item._id?.toString(),

        make: item.makeName,
        model: item.modelName,
        trim: item.trimName,
        year: item.year,
        // end here

        weight: item.weight,
        name: `${item.year} ${item.makeName} ${item.modelName} ${item.trimName} - ${formattedPartName}`.trim(),
        sku: item.sku,
        "productType": 1,
        visible: false,
        brand: item.makeName,
        price: 0,
        currency: "USD",
        description: description,
        productInfo: {
          additionalInfoSections: [
            { "title": "Description", "description": description },
            { "title": "Fitment", "description": "" },
            { "title": "Source Vehicle", "description": sourceVehicleHtml },
            { "title": "Return and Refund Policy", "description": "" },
          ]
        }
      };
    });

    // Temp. DEBUG by shiva
    console.log(
        "FIRST PRODUCT =>",
        JSON.stringify(formattedInventories[0], null, 2)
    );
    // end here

    res.status(200).json(formattedInventories);
  } catch (error) {
    console.error("Error exporting inventories:", error);
    res.status(500).json({ message: "Server error while exporting inventories" });
  }
};

const syncInventoriesV3 = async (req, res) => {
  try {
    const axios = require("axios");
    const inventories = await Inventory.aggregate([
      // Active Inventory is the source of truth: exclude soft-deleted records
      // before any join/formatting happens.
      // Sold parts (eBay/Wix) are out of stock and are not pushed either.
      { $match: { isDeleted: { $ne: true }, saleStatus: { $ne: "sold" } } },

      // Join with Make
      {
        $lookup: {
          from: "makes",
          localField: "make",
          foreignField: "_id",
          as: "make",
        },
      },
      { $unwind: { path: "$make", preserveNullAndEmptyArrays: true } },

      // Join with Model
      {
        $lookup: {
          from: "models",
          localField: "model",
          foreignField: "_id",
          as: "model",
        },
      },
      { $unwind: { path: "$model", preserveNullAndEmptyArrays: true } },

      // Join with Trim
      {
        $lookup: {
          from: "trims",
          localField: "trim",
          foreignField: "_id",
          as: "trim",
        },
      },
      { $unwind: { path: "$trim", preserveNullAndEmptyArrays: true } },

      // Join with Tag
      {
        $lookup: {
          from: "tags",
          localField: "_id",
          foreignField: "inventoryId",
          as: "tag",
        },
      },
      { $unwind: { path: "$tag", preserveNullAndEmptyArrays: true } },

      // Join with CarIntake by VIN
      {
        $lookup: {
          from: "carintakes",
          localField: "vin",
          foreignField: "vin",
          as: "carIntake",
        },
      },
      { $unwind: { path: "$carIntake", preserveNullAndEmptyArrays: true } },

      // Raw projection
      {
        $project: {
          _id: 0,
          year: { $ifNull: ["$year", ""] },
          makeName: { $ifNull: ["$make.name", ""] },
          modelName: { $ifNull: ["$model.name", ""] },
          trimName: { $ifNull: ["$trim.name", ""] },
          partName: { $ifNull: ["$partName", ""] },
          vin: { $ifNull: ["$vin", "N/A"] },
          weight: { $ifNull: ["$weight", 0] },
          sku: { $ifNull: ["$tag.barcodeString", null] },
          cd: { $ifNull: ["$carIntake.carDetails", {}] },
          vd: { $ifNull: ["$carIntake.vinDetails", {}] },
        },
      },
    ]);

    // Wix export boundary only — windShield/a1/a2 stay in Inventory/CRM,
    // they just never enter a Wix-bound payload.
    const syncableInventories = inventories.filter(
      (item) => !isWixExcludedPart(item.partName)
    );

    const formattedProducts = syncableInventories.map(item => {
      const formattedPartName = toTitleFromCamelCase(item.partName);
      const cd = item.cd || {};
      const vd = item.vd || {};

      const val = (...args) => {
        for (const arg of args) {
          if (arg && arg !== "N/A" && arg !== "") return arg;
        }
        return "N/A";
      };

      const sourceVehicleHtml = `<ul>
	<li><p>Year:${val(item.year, vd.ModelYear)}</p></li>
	<li><p>Make:${val(item.makeName, vd.Make)}</p></li>
	<li><p>Model:${val(item.modelName, vd.Model)}</p></li>
	<li><p>Model Type:${val(item.trimName, vd.Trim)}</p></li>
	<li><p>Body: ${val(cd.bodyClass, vd.BodyClass)}</p></li>
	<li><p>Door Structure:${val(cd.doorCount, vd.Doors)}</p></li>
	<li><p>Cylinders:${val(cd.cylinders, vd.EngineCylinders)}</p></li>
	<li><p>Engine Size:${val(cd.engine, vd.DisplacementL)}</p></li>
	<li><p>Transmission:${val(cd.transmission, vd.TransmissionStyle)}</p></li>
	<li><p>Drive Train:${val(cd.drive, vd.DriveType)}</p></li>
	<li><p>Steering:${val(cd.steering, "POWER")}</p></li>
	<li><p>Brakes:${val(cd.brakes, vd.BrakeSystemType)}</p></li>
	<li><p>ABS:${val(cd.abs, "Y")}</p></li>
	<li><p>Primary Ext Color:${val(cd.color)}</p></li>
	<li><p>Primary Int Color:${val(cd.interiorColor)}</p></li>
	<li><p>Seat Mat:${val(cd.seatMaterial)}</p></li>
	<li><p>Roof Type:${val(cd.roofType)}</p></li>
	<li><p>Win Regulator:${val(cd.windowRegulator)}</p></li>
</ul>`;

      return {
        product: {
          name: `${item.year} ${item.makeName} ${item.modelName} ${item.trimName} - ${formattedPartName}`.trim(),
          productType: "PHYSICAL",
          visible: false,
          brand: item.makeName,
          variantsInfo: {
            variants: [{
              sku: item.sku || "",
              price: {
                actualPrice: {
                  amount: "0.00"
                }
              },
              physicalProperties: {
                weight: item.weight || 0
              }
            }]
          },
          infoSections: [
            { title: "Description", plainDescription: " ", uniqueName: "description" },
            { title: "Fitment", plainDescription: " ", uniqueName: "fitment" },
            { title: "Source Vehicle", plainDescription: sourceVehicleHtml, uniqueName: "source-vehicle" },
            { title: "Return and Refund Policy", plainDescription: " ", uniqueName: "return-policy" },
          ]
        }
      };
    });

    // Background Execution for batches
    const processInBg = async (products) => {
      const BATCH_SIZE = 25; // Wix V3 limits total info sections to 100 per bulk request (4 per product * 25 = 100)
      const CONCURRENCY = 2; // Process 2 batches at a time to stay safe with rate limits
      const batches = [];

      for (let i = 0; i < products.length; i += BATCH_SIZE) {
        batches.push(products.slice(i, i + BATCH_SIZE));
      }

      console.log(`Starting background sync for ${products.length} products in ${batches.length} batches...`);

      for (let i = 0; i < batches.length; i += CONCURRENCY) {
        const currentBatches = batches.slice(i, i + CONCURRENCY);

        await Promise.all(currentBatches.map(async (batch, index) => {
          const batchIdx = i + index + 1;
          try {
            await axios.post(
              "https://www.wixapis.com/stores/v3/bulk/products/create",
              {
                products: batch,
                returnEntity: false
              },
              {
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": process.env.WIX_API_KEY,
                  "wix-site-id": process.env.WIX_SITE_ID,
                },
              }
            );
            console.log(`Batch ${batchIdx}/${batches.length} synced successfully.`);
          } catch (err) {
            console.error(`Error syncing batch ${batchIdx}:`, err.response?.data || err.message);
          }
        }));
      }
      console.log("Wix V3 Sync background process completed.");
    };

    // Trigger background process
    processInBg(formattedProducts).catch(err => console.error("Critical error in background sync:", err));

    res.status(202).json({
      message: "Wix V3 Sync started in the background",
      totalProducts: formattedProducts.length,
      estimatedBatches: Math.ceil(formattedProducts.length / 25),
    });
  } catch (error) {
    console.error("Error in syncInventoriesV3 initiation:", error);
    res.status(500).json({ message: "Server error while initiating Wix V3 sync" });
  }
};


/**
 * Deduplicate Inventory — removes duplicate Inventory records
 * that share the same partName (case-insensitive) + make + model + trim + year + vin.
 * Keeps only the oldest record per group.
 * POST /api/inventory/deduplicate
 */
const deduplicateInventory = async (req, res) => {
  try {
    const duplicates = await Inventory.aggregate([
      {
        $group: {
          _id: {
            partName: { $toLower: "$partName" },
            make: "$make",
            model: "$model",
            trim: "$trim",
            year: "$year",
            vin: "$vin",
          },
          count: { $sum: 1 },
          // Was just `$push: "$_id"` — widened to also carry ebayListingId/
          // wixProductId so a duplicate that already has a LIVE external
          // listing linked to it (see the eBay-sync-safety guard below) can
          // be identified without a second query per group.
          docs: { $push: { id: "$_id", ebayListingId: "$ebayListingId", wixProductId: "$wixProductId" } },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ]);

    let totalRemoved = 0;
    let totalSkippedLiveLinks = 0;
    const removed = [];

    for (const group of duplicates) {
      const [, ...candidates] = group.docs; // keep first, consider removing the rest

      // Never hard-delete a duplicate that is the CRM's only record of a
      // LIVE eBay or Wix listing — doing so would permanently orphan that
      // listing (no ebayListingId/wixProductId anywhere in Mongo means no
      // future sync run can ever find, update, or end it again). Route
      // these to manual review instead of silently destroying the linkage.
      const removeIds = [];
      const skippedForLiveLink = [];
      for (const doc of candidates) {
        if (doc.ebayListingId || doc.wixProductId) {
          skippedForLiveLink.push(doc.id);
        } else {
          removeIds.push(doc.id);
        }
      }
      if (skippedForLiveLink.length > 0) {
        totalSkippedLiveLinks += skippedForLiveLink.length;
        console.warn(
          `[INVENTORY_DEDUP] Skipped deleting ${skippedForLiveLink.length} duplicate(s) with a live eBay/Wix listing linked (manual review required):`,
          skippedForLiveLink.map(String)
        );
      }

      if (removeIds.length === 0) {
        continue;
      }

      const result = await Inventory.deleteMany({ _id: { $in: removeIds } });
      totalRemoved += result.deletedCount;
      removed.push({
        key: `${group._id.partName} | ${group._id.make} | ${group._id.model}`,
        removed: result.deletedCount,
        skippedForLiveLink: skippedForLiveLink.length,
      });
    }

    const remaining = await Inventory.countDocuments();

    return res.status(200).json({
      success: true,
      duplicateGroupsFound: duplicates.length,
      totalRemoved,
      totalSkippedLiveLinks,
      remaining,
      details: removed,
    });
  } catch (error) {
    console.error("Error deduplicating inventory:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  createInventory,
  bulkCreateInventory,
  getInventoryByVIN,
  updateInventoryPrice,
  getPartsMasterList,
  getAllInventories,
  searchByMakeModelYear,
  exportInventories,
  syncInventoriesV3,
  deduplicateInventory,
};
