const mongoose = require("mongoose");
const Inventory = require("../models/Inventory.model");
const Part = require("../models/Part.model");
const Make = require("../models/Make.model");
const CarModel = require("../models/CarModel.model");
const Trim = require("../models/Trim.model");

const generateShortName = (name) => {
  if (!name) return "";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].length <= 3 ? parts[0].toUpperCase() : parts[0].slice(0, 2).toUpperCase();
  return parts.map(w => w.charAt(0).toUpperCase()).join("");
};

const toTitleFromCamelCase = (input) => {
  if (typeof input !== "string") return "";
  return input.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, c => c.toUpperCase());
};

// POST /api/inventory
const createInventory = async (req, res) => {
  try {
    const { partName, unit, cleaned, quality, location, weight, dimensions, make, model, trim, vin, year, color, image } = req.body;

    // Resolve Make
    let makeDoc = mongoose.Types.ObjectId.isValid(make) ? await Make.findById(make) : null;
    if (!makeDoc && make) makeDoc = await Make.findOne({ name: make }) || await Make.create({ name: make, shortName: generateShortName(make) });
    const makeId = makeDoc?._id;

    // Resolve Model
    let modelDoc = mongoose.Types.ObjectId.isValid(model) ? await CarModel.findById(model) : null;
    if (!modelDoc && model) modelDoc = await CarModel.findOne({ name: model, make: makeId }) || await CarModel.create({ name: model, make: makeId, shortName: generateShortName(model) });
    const modelId = modelDoc?._id;

    // Resolve Trim
    let trimDoc = mongoose.Types.ObjectId.isValid(trim) ? await Trim.findById(trim) : null;
    if (!trimDoc && trim) trimDoc = await Trim.findOne({ name: trim, model: modelId }) || await Trim.create({ name: trim, make: makeId, model: modelId, shortName: generateShortName(trim) });
    const trimId = trimDoc?._id;

    // Resolve Part for shortName/category
    let partDoc = null;
    let resolvedPartShort = "";
    let category = "Uncategorized";
    if (partName) {
      partDoc = await Part.findOne({ name: new RegExp(`^${partName}$`, "i") });
      if (partDoc?.shortName) resolvedPartShort = partDoc.shortName;
      if (partDoc?.category) category = partDoc.category;
    }
    if (!resolvedPartShort) resolvedPartShort = generateShortName(partName || "");

    const sku = `${makeDoc?.shortName || ""}/${modelDoc?.shortName || ""}/${year || ""}-${resolvedPartShort}/${color || ""}`;

    const inventory = await Inventory.create({
      partName, category, unit, cleaned: cleaned || false, quality, location, weight, dimensions,
      make: makeId, model: modelId, trim: trimId, vin, sku, year, color, image: image || null,
    });

    res.status(201).json({ message: "Inventory created successfully", data: inventory });
  } catch (error) {
    console.error("Error creating inventory:", error);
    res.status(500).json({ message: "Server error while creating inventory", details: error.message });
  }
};

// GET /api/inventory
const getAllInventories = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const filter = { isDeleted: { $ne: true } };
    if (req.query.make) filter.make = req.query.make;
    if (req.query.model) filter.model = req.query.model;
    if (req.query.trim) filter.trim = req.query.trim;
    if (req.query.search) filter.partName = { $regex: req.query.search, $options: "i" };

    const [inventories, total] = await Promise.all([
      Inventory.find(filter).populate("make").populate("model").populate("trim").skip(skip).limit(limit).sort({ updatedAt: -1 }),
      Inventory.countDocuments(filter),
    ]);
    res.status(200).json({ inventories, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error("Get inventories error:", error);
    res.status(500).json({ message: "Server error while fetching inventory" });
  }
};

// GET /api/inventory/vin/:vin
const getInventoryByVIN = async (req, res) => {
  try {
    const inventoryItems = await Inventory.find({ vin: req.params.vin }).populate("make model trim");
    res.status(200).json({ inventoryItems });
  } catch (error) {
    res.status(500).json({ message: "Server error while fetching inventory by VIN" });
  }
};

// GET /api/inventory/parts  — master parts list
const getPartsMasterList = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const skip = (page - 1) * limit;
    const filter = { isDeleted: { $ne: true } };
    if (req.query.make) filter.make = req.query.make;
    if (req.query.model) filter.model = req.query.model;
    if (req.query.cleaned !== undefined) filter.cleaned = req.query.cleaned === "true";
    if (req.query.search) filter.partName = { $regex: req.query.search, $options: "i" };

    const [items, total] = await Promise.all([
      Inventory.find(filter).populate("make", "name shortName").populate("model", "name shortName").populate("trim", "name shortName").select("partName unit cleaned quality location weight dimensions sku year color").skip(skip).limit(limit).sort({ updatedAt: -1 }).lean(),
      Inventory.countDocuments(filter),
    ]);

    const parts = items.map(it => ({
      _id: it._id, partName: it.partName, unit: it.unit, cleaned: it.cleaned,
      quality: it.quality, location: it.location, weight: it.weight,
      dimensions: it.dimensions, sku: it.sku, year: it.year, color: it.color,
      make: it.make ? { _id: it.make._id, name: it.make.name } : null,
      model: it.model ? { _id: it.model._id, name: it.model.name } : null,
      trim: it.trim ? { _id: it.trim._id, name: it.trim.name } : null,
    }));

    res.status(200).json({ parts, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error("Error fetching parts master list:", error);
    res.status(500).json({ message: "Server error while fetching parts" });
  }
};

// GET /api/inventory/export  — Wix-formatted export
const exportInventories = async (req, res) => {
  try {
    const inventories = await Inventory.aggregate([
      { $lookup: { from: "makes", localField: "make", foreignField: "_id", as: "make" } },
      { $unwind: { path: "$make", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "carmodels", localField: "model", foreignField: "_id", as: "model" } },
      { $unwind: { path: "$model", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "trims", localField: "trim", foreignField: "_id", as: "trim" } },
      { $unwind: { path: "$trim", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "tags", localField: "_id", foreignField: "inventoryId", as: "tag" } },
      { $unwind: { path: "$tag", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "carintakes", localField: "vin", foreignField: "vin", as: "carIntake" } },
      { $unwind: { path: "$carIntake", preserveNullAndEmptyArrays: true } },
      { $project: { _id: 1, year: { $ifNull: ["$year", ""] }, makeName: { $ifNull: ["$make.name", ""] }, modelName: { $ifNull: ["$model.name", ""] }, trimName: { $ifNull: ["$trim.name", ""] }, partName: { $ifNull: ["$partName", ""] }, vin: { $ifNull: ["$vin", "N/A"] }, weight: { $ifNull: ["$weight", 0] }, sku: { $ifNull: ["$tag.barcodeString", null] }, cd: { $ifNull: ["$carIntake.carDetails", {}] }, vd: { $ifNull: ["$carIntake.vinDetails", {}] } } },
    ]);

    const val = (...args) => { for (const a of args) { if (a && a !== "N/A" && a !== "") return a; } return "N/A"; };

    const formatted = inventories.map(item => {
      const partName = toTitleFromCamelCase(item.partName);
      const { cd = {}, vd = {} } = item;
      const sourceVehicleHtml = `<ul><li><p>Year:${val(item.year, vd.ModelYear)}</p></li><li><p>Make:${val(item.makeName, vd.Make)}</p></li><li><p>Model:${val(item.modelName, vd.Model)}</p></li><li><p>Trim:${val(item.trimName, vd.Trim)}</p></li><li><p>Body:${val(cd.bodyClass, vd.BodyClass)}</p></li><li><p>Engine:${val(cd.engine, vd.DisplacementL)}</p></li><li><p>Drive:${val(cd.drive, vd.DriveType)}</p></li></ul>`;
      const description = `${partName}, Condition: Used, Year: ${item.year}, Make: ${item.makeName}, Model: ${item.modelName}, Trim: ${item.trimName}`;
      return {
        externalId: item._id?.toString(), make: item.makeName, model: item.modelName,
        trim: item.trimName, year: item.year, weight: item.weight,
        name: `${item.year} ${item.makeName} ${item.modelName} ${item.trimName} - ${partName}`.trim(),
        sku: item.sku, productType: 1, visible: false, brand: item.makeName, price: 0, currency: "USD", description,
        productInfo: { additionalInfoSections: [{ title: "Description", description }, { title: "Fitment", description: "" }, { title: "Source Vehicle", description: sourceVehicleHtml }, { title: "Return and Refund Policy", description: "" }] },
      };
    });

    res.status(200).json(formatted);
  } catch (error) {
    console.error("Error exporting inventories:", error);
    res.status(500).json({ message: "Server error while exporting inventories" });
  }
};

// POST /api/inventory/deduplicate
const deduplicateInventory = async (req, res) => {
  try {
    const duplicates = await Inventory.aggregate([
      { $group: { _id: { partName: { $toLower: "$partName" }, make: "$make", model: "$model", trim: "$trim", year: "$year", vin: "$vin" }, count: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } },
    ]);

    let totalRemoved = 0;
    const removed = [];
    for (const group of duplicates) {
      const [, ...removeIds] = group.ids;
      const result = await Inventory.deleteMany({ _id: { $in: removeIds } });
      totalRemoved += result.deletedCount;
      removed.push({ key: `${group._id.partName}|${group._id.make}|${group._id.model}`, removed: result.deletedCount });
    }

    const remaining = await Inventory.countDocuments();
    res.status(200).json({ success: true, duplicateGroupsFound: duplicates.length, totalRemoved, remaining, details: removed });
  } catch (error) {
    console.error("Error deduplicating:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// PATCH /api/inventory/:id/soft-delete
const softDeleteInventory = async (req, res) => {
  try {
    const inv = await Inventory.findByIdAndUpdate(req.params.id, { isDeleted: true, deletedAt: new Date() }, { new: true });
    if (!inv) return res.status(404).json({ message: "Inventory item not found" });
    res.status(200).json({ message: "Inventory item deleted", data: inv });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = { createInventory, getAllInventories, getInventoryByVIN, getPartsMasterList, exportInventories, deduplicateInventory, softDeleteInventory };
