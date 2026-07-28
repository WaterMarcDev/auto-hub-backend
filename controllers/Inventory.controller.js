const Make = require("../models/Make");
const CarModel = require("../models/Model.model");
const Trim = require("../models/Trim.model");
const Inventory = require("../models/Inventory.model");
const Part = require("../models/Part.model");


const mongoose = require("mongoose");

function toTitleFromCamelCase(input) {
  if (typeof input !== "string") return "";
  return input
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, char => char.toUpperCase());
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
      color,
      image,
    } = req.body;

    // Resolve Make: accept ObjectId or name
    let makeDoc = null;
    let makeId = null;
    if (make && mongoose.Types.ObjectId.isValid(make)) {
      makeDoc = await Make.findById(make);
      if (makeDoc) makeId = makeDoc._1d || makeDoc._id;
    }
    if (!makeDoc && make) {
      makeDoc = await Make.findOne({ name: make });
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
        name: new RegExp(`^${partName}$`, "i"),
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
            name: new RegExp(`^${partName}$`, "i"),
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
    });

    res
      .status(201)
      .json({ message: "Inventory created successfully", data: inventory });
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

// @desc    Get all inventory items
// @route   GET /api/inventory
// @access  Private
const getAllInventories = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const filter = {};
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

    const filter = {};
    if (req.query.make) filter.make = req.query.make;
    if (req.query.model) filter.model = req.query.model;
    if (req.query.trim) filter.trim = req.query.trim;
    if (req.query.cleaned !== undefined) {
      const val = req.query.cleaned;
      if (val === "true" || val === "1") filter.cleaned = true;
      else if (val === "false" || val === "0") filter.cleaned = false;
    }
    if (req.query.quality) filter.quality = req.query.quality;
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
        "partName unit cleaned quality location weight dimensions sku year color"
      )
      .skip(skip)
      .limit(limit)
      .sort({ updatedAt: -1 })
      .lean();

    const parts = items.map((it) => ({
      _id: it._id,
      partName: it.partName,
      unit: it.unit,
      cleaned: it.cleaned,
      quality: it.quality,
      location: it.location,
      weight: it.weight,
      dimensions: it.dimensions,
      sku: it.sku,
      year: it.year,
      color: it.color,
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
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const skip = (page - 1) * limit;

    const filter = {};

    if (make) {
      const makeDoc = mongoose.Types.ObjectId.isValid(make)
        ? await Make.findById(make)
        : await Make.findOne({ name: make });
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
        "partName unit cleaned quality location weight dimensions sku year color"
      )
      .skip(skip)
      .limit(limit)
      .sort({ updatedAt: -1 })
      .lean();

    const parts = items.map((it) => ({
      _id: it._id,
      partName: it.partName,
      unit: it.unit,
      cleaned: it.cleaned,
      quality: it.quality,
      location: it.location,
      weight: it.weight,
      dimensions: it.dimensions,
      sku: it.sku,
      year: it.year,
      color: it.color,
      make: it.make ? { _id: it.make._id, name: it.make.name } : null,
      model: it.model ? { _id: it.model._id, name: it.model.name } : null,
      trim: it.trim ? { _id: it.trim._id, name: it.trim.name } : null,
    }));

    res.status(200).json({
      parts,
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

    const formattedProducts = inventories.map(item => {
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
          ids: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ]);

    let totalRemoved = 0;
    const removed = [];

    for (const group of duplicates) {
      const [, ...removeIds] = group.ids; // keep first, remove rest
      const result = await Inventory.deleteMany({ _id: { $in: removeIds } });
      totalRemoved += result.deletedCount;
      removed.push({
        key: `${group._id.partName} | ${group._id.make} | ${group._id.model}`,
        removed: result.deletedCount,
      });
    }

    const remaining = await Inventory.countDocuments();

    return res.status(200).json({
      success: true,
      duplicateGroupsFound: duplicates.length,
      totalRemoved,
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
  getInventoryByVIN,
  getPartsMasterList,
  getAllInventories,
  searchByMakeModelYear,
  exportInventories,
  syncInventoriesV3,
  deduplicateInventory,
};
