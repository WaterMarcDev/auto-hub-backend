const Make = require("../models/Make");
const CarModel = require("../models/Model.model");
const Trim = require("../models/Trim.model");
const Inventory = require("../models/Inventory.model");
const Part = require("../models/Part.model");

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
    const {
      partName,
      unit,
      cleaned,
      quality,
      location,
      weight,
      dimensions,
      make,
      model,
      trim,
      vin,
      year,
      partShortName,
      color,
    } = req.body;

    let makeDoc = await Make.findOne({ name: make });
    if (!makeDoc) {
      makeDoc = await Make.create({
        name: make,
        shortName: generateShortName(make),
      });
    }
    const makeId = makeDoc._id;

    let modelDoc = await CarModel.findOne({ name: model, make: makeId });
    if (!modelDoc) {
      modelDoc = await CarModel.create({
        name: model,
        make: makeId,
        shortName: generateShortName(model),
      });
    }
    const modelId = modelDoc._id;

    let trimDoc = await Trim.findOne({ name: trim, model: modelId });
    if (!trimDoc) {
      trimDoc = await Trim.create({
        name: trim,
        make: makeId,
        model: modelId,
        shortName: generateShortName(trim),
      });
    }
    const trimId = trimDoc._id;

    // Resolve partShortName server-side. Prefer an existing Part.shortName, fall back to name, else generate.
    let resolvedPartShort = "";
    try {
      if (partName) {
        // Try exact shortName match first
        let partDoc = (await Part.findOne({ shortName: partName })) || null;
        if (!partDoc) {
          // Try by name (case-insensitive)
          partDoc = await Part.findOne({
            name: new RegExp(`^${partName}$`, "i"),
          });
        }
        if (partDoc && partDoc.shortName) resolvedPartShort = partDoc.shortName;
      }
    } catch (e) {
      // ignore lookup errors and fall back to generation
    }

    if (!resolvedPartShort) {
      resolvedPartShort = generateShortName(partName || "");
    }

    // AD/44/2008-FB/W

    const tag = `${makeDoc.shortName}/${modelDoc.shortName}/${year}-${resolvedPartShort}/${color}`;

    const inventory = await Inventory.create({
      partName,
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
      tag: tag,
    });

    res.status(201).json({
      message: "Inventory created successfully",
      data: inventory,
    });
  } catch (error) {
    console.error("Error creating inventory:", error);
    res.status(500).json({ message: "Server error while creating inventory" });
  }
};

const getInventoryByVIN = async (req, res) => {
  try {
    const { vin } = req.params;
    const inventoryItems = await Inventory.find({ vin }).populate(
      "make model trim"
    );
    res.status(200).json({ inventoryItems });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Server error while fetching inventory by VIN" });
  }
};

module.exports = {
  createInventory,
  getInventoryByVIN,
};
