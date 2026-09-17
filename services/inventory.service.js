/**
 * Inventory business logic. Extracted 1:1 from
 * controllers/Inventory.controller.js during the clean-architecture
 * migration — every Make/Model/Trim/Part resolution rule, SKU-building
 * formula, aggregation pipeline, Wix V3 export payload shape, and the
 * duplicate-cleanup live-link safety guard are preserved exactly.
 */
const mongoose = require("mongoose");
const makeRepository = require("../repositories/make.repository");
const modelRepository = require("../repositories/model.repository");
const trimRepository = require("../repositories/trim.repository");
const inventoryRepository = require("../repositories/inventory.repository");
const partRepository = require("../repositories/part.repository");
const { isWixExcludedPart } = require("../utils/wixExportExclusions");
const { resolvePartPrice } = require("../utils/partPricing");
const { isGermanVehicle } = require("../utils/vehicleClassification");
const { toTitleFromCamelCase, buildCaseInsensitiveNameQuery } = require("../utils/productIdentity");

function validationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

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
  return makeRepository.findOne(buildCaseInsensitiveNameQuery(rawName));
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

  return parts.map((w) => w.charAt(0).toUpperCase()).join("");
};

function parsePriceOrThrow(price) {
  let parsedPrice = null;
  if (price !== undefined && price !== null && price !== "") {
    const numericPrice = Number(price);
    if (Number.isNaN(numericPrice) || numericPrice < 0) {
      throw validationError("Price must be a non-negative number");
    }
    parsedPrice = numericPrice;
  }
  return parsedPrice;
}

async function createInventory(body) {
  const {
    partName, unit, cleaned, quality, location, weight, dimensions,
    make, model, trim, vin, year, color, image, price,
  } = body;

  const parsedPrice = parsePriceOrThrow(price);

  // Resolve Make: accept ObjectId or name
  let makeDoc = null;
  let makeId = null;
  if (make && mongoose.Types.ObjectId.isValid(make)) {
    makeDoc = await makeRepository.findById(make);
    if (makeDoc) makeId = makeDoc._1d || makeDoc._id;
  }
  if (!makeDoc && make) {
    makeDoc = await findMakeByNameCaseInsensitive(make);
  }
  if (!makeDoc && make) {
    makeDoc = await makeRepository.create({ name: make, shortName: generateShortName(make) });
  }
  if (makeDoc) makeId = makeDoc._id;

  // Resolve Model: accept ObjectId or name; if model is id but make not provided, derive make from model
  let modelDoc = null;
  let modelId = null;
  if (model && mongoose.Types.ObjectId.isValid(model)) {
    modelDoc = await modelRepository.findById(model);
    if (modelDoc && !makeId && modelDoc.make) {
      const derivedMake = await makeRepository.findById(modelDoc.make);
      if (derivedMake) {
        makeDoc = derivedMake;
        makeId = derivedMake._id;
      }
    }
  }
  if (!modelDoc && model) {
    modelDoc = await modelRepository.findOne({ name: model, make: makeId });
  }
  if (!modelDoc && model) {
    modelDoc = await modelRepository.create({ name: model, make: makeId, shortName: generateShortName(model) });
  }
  if (modelDoc) modelId = modelDoc._id;

  // Resolve Trim: accept ObjectId or name; if trim provided as id, ensure we have model/make
  let trimDoc = null;
  let trimId = null;
  if (trim && mongoose.Types.ObjectId.isValid(trim)) {
    trimDoc = await trimRepository.findById(trim);
    if (trimDoc) {
      if (!modelId && trimDoc.model) {
        const derivedModel = await modelRepository.findById(trimDoc.model);
        if (derivedModel) {
          modelDoc = derivedModel;
          modelId = derivedModel._id;
          if (!makeId && derivedModel.make) {
            const derivedMake = await makeRepository.findById(derivedModel.make);
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
    trimDoc = await trimRepository.findOne({ name: trim, model: modelId });
  }
  if (!trimDoc && trim) {
    trimDoc = await trimRepository.create({ name: trim, make: makeId, model: modelId, shortName: generateShortName(trim) });
  }
  if (trimDoc) trimId = trimDoc._id;

  // Resolve partShortName server-side. Prefer an existing Part.shortName, fall back to name, else generate.
  let resolvedPartShort = "";
  let category = "Uncategorized";

  try {
    const partDocForCategory = await partRepository.findOne({ name: new RegExp(`^${partName}$`, "i") });
    console.log("PART LOOKUP:", partName, JSON.stringify(partDocForCategory, null, 2));
    if (partDocForCategory?.category) {
      category = partDocForCategory.category;
    }
  } catch (e) {
    console.log("Category lookup failed:", e);
  }

  let partDoc = null;
  try {
    if (partName) {
      if (!partDoc) {
        partDoc = await partRepository.findOne({ name: new RegExp(`^${partName}$`, "i") });
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

  const partCategory = partDoc?.category || "Uncategorized";

  const makeShort = (makeDoc && makeDoc.shortName) || "";
  const modelShort = (modelDoc && modelDoc.shortName) || "";
  const sku = `${makeShort}/${modelShort}/${year || ""}-${resolvedPartShort}/${color || ""}`;

  const inventory = await inventoryRepository.create({
    partName,
    category: partCategory,
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
  });

  return inventory;
}

async function getInventoryByVIN(vin) {
  return inventoryRepository.find({ vin }).populate("make model trim");
}

async function updateInventoryPrice(id, price) {
  const parsedPrice = parsePriceOrThrow(price);

  const inventory = await inventoryRepository.findByIdAndUpdate(id, { price: parsedPrice }, { new: true });

  if (!inventory) {
    throw notFoundError("Inventory item not found");
  }

  return inventory;
}

async function getAllInventories(query) {
  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 10;
  const skip = (page - 1) * limit;

  const filter = { isDeleted: { $ne: true } };
  if (query.make) filter.make = query.make;
  if (query.model) filter.model = query.model;
  if (query.trim) filter.trim = query.trim;

  if (query.search?.trim()) {
    console.log("Search Query:", query.search);
    const search = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.partName = { $regex: search, $options: "i" };
  }

  const total = await inventoryRepository.countDocuments(filter);

  const inventories = await inventoryRepository
    .find(filter)
    .populate("make")
    .populate("model")
    .populate("trim")
    .skip(skip)
    .limit(limit)
    .sort({ updatedAt: -1 });

  return {
    inventories,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

async function getPartsMasterList(query) {
  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 25;
  const skip = (page - 1) * limit;

  const filter = {
    isDeleted: { $ne: true },
    $nor: [
      { partName: /^A1$/i },
      { partName: /^A2$/i },
      { partName: /^Wind\s*shield$/i },
      { partName: /^Windshield$/i },
      { partName: /^Wind[_-]?Shield$/i },
    ],
  };
  if (query.make) filter.make = query.make;
  if (query.model) filter.model = query.model;
  if (query.trim) filter.trim = query.trim;
  if (query.cleaned !== undefined) {
    const val = query.cleaned;
    if (val === "true" || val === "1") filter.cleaned = true;
    else if (val === "false" || val === "0") filter.cleaned = false;
  }
  if (query.quality) filter.quality = query.quality;
  if (query.search?.trim()) {
    console.log("Search Query:", query.search);
    const search = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.partName = { $regex: search, $options: "i" };
  }

  console.log("Mongo Filter:", JSON.stringify(filter, null, 2));

  const total = await inventoryRepository.countDocuments(filter);

  const items = await inventoryRepository
    .find(filter)
    .populate("make", "name shortName")
    .populate("model", "name shortName")
    .populate("trim", "name shortName")
    .select("partName unit cleaned quality location weight dimensions sku year color")
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

  return {
    parts,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

async function searchByMakeModelYear(query) {
  const { make, model, year, partName } = query;

  if (!make || !model || !year) {
    throw validationError("Make, model, and year are required");
  }

  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 25;
  const skip = (page - 1) * limit;

  const filter = {};
  const emptyResult = { parts: [], pagination: { page, limit, total: 0, pages: 0 } };

  if (make) {
    const makeDoc = mongoose.Types.ObjectId.isValid(make)
      ? await makeRepository.findById(make)
      : await findMakeByNameCaseInsensitive(make);
    if (!makeDoc) {
      return emptyResult;
    }
    filter.make = makeDoc._id;
  }

  if (model) {
    const modelQuery = { name: model };
    if (filter.make) modelQuery.make = filter.make;
    const modelDoc = mongoose.Types.ObjectId.isValid(model)
      ? await modelRepository.findById(model)
      : await modelRepository.findOne(modelQuery);
    if (!modelDoc) {
      return emptyResult;
    }
    filter.model = modelDoc._id;
  }

  if (year) {
    const parsedYear = Number(year);
    if (!Number.isNaN(parsedYear)) filter.year = parsedYear;
  }

  if (partName?.trim()) {
    const normalize = (text = "") =>
      String(text).trim().replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[\s_-]+/g, "");

    const normalizedSearch = normalize(partName);

    const parts = await partRepository.find({}, { name: 1, _id: 0 }).lean();

    const matchedPart = parts.find((part) => normalize(part.name) === normalizedSearch);

    if (!matchedPart) {
      return emptyResult;
    }

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
                    replacement: "",
                  },
                },
                find: "_",
                replacement: "",
              },
            },
            find: "-",
            replacement: "",
          },
        },
        normalizedSearch,
      ],
    };
  }

  const total = await inventoryRepository.countDocuments(filter);

  const items = await inventoryRepository
    .find(filter)
    .populate("make", "name shortName")
    .populate("model", "name shortName")
    .populate("trim", "name shortName")
    .select("partName unit cleaned quality location weight dimensions sku year color price")
    .skip(skip)
    .limit(limit)
    .sort({ updatedAt: -1 })
    .lean();

  const endpoint = items.map((it) => {
    const isGerman = isGermanVehicle(it.make?.name);
    const priceResult = resolvePartPrice({ partName: it.partName, isGerman });

    return {
      make: it.make?.name || "",
      model: it.model?.name || "",
      year: it.year || "",
      partName: it.partName || "",
      urlEndpoint: [it.year, it.make?.name, it.model?.name, it.trim?.name, toTitleFromCamelCase(it.partName || "")]
        .filter(Boolean)
        .join("-")
        .toLowerCase()
        .replace(/\s+/g, "-"),
      price: priceResult?.price ?? null,
      condition: it.quality || "",
    };
  });

  return {
    parts: endpoint,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

// Shared aggregation pipeline used by both exportInventories and
// syncInventoriesV3's raw-data step.
function buildExportAggregationPipeline(extraMatch) {
  const pipeline = [];
  if (extraMatch) pipeline.push({ $match: extraMatch });
  pipeline.push(
    { $lookup: { from: "makes", localField: "make", foreignField: "_id", as: "make" } },
    { $unwind: { path: "$make", preserveNullAndEmptyArrays: true } },
    { $lookup: { from: "models", localField: "model", foreignField: "_id", as: "model" } },
    { $unwind: { path: "$model", preserveNullAndEmptyArrays: true } },
    { $lookup: { from: "trims", localField: "trim", foreignField: "_id", as: "trim" } },
    { $unwind: { path: "$trim", preserveNullAndEmptyArrays: true } },
    { $lookup: { from: "tags", localField: "_id", foreignField: "inventoryId", as: "tag" } },
    { $unwind: { path: "$tag", preserveNullAndEmptyArrays: true } },
    { $lookup: { from: "carintakes", localField: "vin", foreignField: "vin", as: "carIntake" } },
    { $unwind: { path: "$carIntake", preserveNullAndEmptyArrays: true } }
  );
  return pipeline;
}

function buildSourceVehicleHtml(item) {
  const cd = item.cd || {};
  const vd = item.vd || {};
  const val = (...args) => {
    for (const arg of args) {
      if (arg && arg !== "N/A" && arg !== "") return arg;
    }
    return "N/A";
  };

  return `<ul>
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
}

async function exportInventories() {
  const inventories = await inventoryRepository.aggregate([
    ...buildExportAggregationPipeline(null),
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
        cd: { $ifNull: ["$carIntake.carDetails", {}] },
        vd: { $ifNull: ["$carIntake.vinDetails", {}] },
      },
    },
  ]);

  const formattedInventories = inventories.map((item) => {
    const formattedPartName = toTitleFromCamelCase(item.partName);
    const sourceVehicleHtml = buildSourceVehicleHtml(item);
    const description = `${formattedPartName}, Condition: Used, Part Number: 123456789, Year: ${item.year}, Make: ${item.makeName}, Model: ${item.modelName}, Trim: ${item.trimName}, Body: SUV`;

    return {
      externalId: item._id?.toString(),
      make: item.makeName,
      model: item.modelName,
      trim: item.trimName,
      year: item.year,
      weight: item.weight,
      name: `${item.year} ${item.makeName} ${item.modelName} ${item.trimName} - ${formattedPartName}`.trim(),
      sku: item.sku,
      productType: 1,
      visible: false,
      brand: item.makeName,
      price: 0,
      currency: "USD",
      description,
      productInfo: {
        additionalInfoSections: [
          { title: "Description", description },
          { title: "Fitment", description: "" },
          { title: "Source Vehicle", description: sourceVehicleHtml },
          { title: "Return and Refund Policy", description: "" },
        ],
      },
    };
  });

  console.log("FIRST PRODUCT =>", JSON.stringify(formattedInventories[0], null, 2));

  return formattedInventories;
}

/**
 * Runs the actual batch POST to Wix's bulk products/create API. Kept as its
 * own function (not inlined) purely for readability — this is Wix
 * synchronization logic and is preserved byte-for-byte, unmodified, from
 * the original controller (batch size, concurrency, headers, endpoint).
 */
async function processWixV3BatchesInBackground(products) {
  const axios = require("axios");
  const BATCH_SIZE = 25; // Wix V3 limits total info sections to 100 per bulk request (4 per product * 25 = 100)
  const CONCURRENCY = 2; // Process 2 batches at a time to stay safe with rate limits
  const batches = [];

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    batches.push(products.slice(i, i + BATCH_SIZE));
  }

  console.log(`Starting background sync for ${products.length} products in ${batches.length} batches...`);

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const currentBatches = batches.slice(i, i + CONCURRENCY);

    await Promise.all(
      currentBatches.map(async (batch, index) => {
        const batchIdx = i + index + 1;
        try {
          await axios.post(
            "https://www.wixapis.com/stores/v3/bulk/products/create",
            { products: batch, returnEntity: false },
            {
              headers: {
                "Content-Type": "application/json",
                Authorization: process.env.WIX_API_KEY,
                "wix-site-id": process.env.WIX_SITE_ID,
              },
            }
          );
          console.log(`Batch ${batchIdx}/${batches.length} synced successfully.`);
        } catch (err) {
          console.error(`Error syncing batch ${batchIdx}:`, err.response?.data || err.message);
        }
      })
    );
  }
  console.log("Wix V3 Sync background process completed.");
}

async function initiateSyncInventoriesV3() {
  const inventories = await inventoryRepository.aggregate([
    ...buildExportAggregationPipeline({ isDeleted: { $ne: true } }),
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
  const syncableInventories = inventories.filter((item) => !isWixExcludedPart(item.partName));

  const formattedProducts = syncableInventories.map((item) => {
    const formattedPartName = toTitleFromCamelCase(item.partName);
    const sourceVehicleHtml = buildSourceVehicleHtml(item);

    return {
      product: {
        name: `${item.year} ${item.makeName} ${item.modelName} ${item.trimName} - ${formattedPartName}`.trim(),
        productType: "PHYSICAL",
        visible: false,
        brand: item.makeName,
        variantsInfo: {
          variants: [
            {
              sku: item.sku || "",
              price: { actualPrice: { amount: "0.00" } },
              physicalProperties: { weight: item.weight || 0 },
            },
          ],
        },
        infoSections: [
          { title: "Description", plainDescription: " ", uniqueName: "description" },
          { title: "Fitment", plainDescription: " ", uniqueName: "fitment" },
          { title: "Source Vehicle", plainDescription: sourceVehicleHtml, uniqueName: "source-vehicle" },
          { title: "Return and Refund Policy", plainDescription: " ", uniqueName: "return-policy" },
        ],
      },
    };
  });

  // Trigger background process (fire-and-forget, exactly as the original controller did)
  processWixV3BatchesInBackground(formattedProducts).catch((err) =>
    console.error("Critical error in background sync:", err)
  );

  return {
    totalProducts: formattedProducts.length,
    estimatedBatches: Math.ceil(formattedProducts.length / 25),
  };
}

/**
 * Deduplicate Inventory — removes duplicate Inventory records
 * that share the same partName (case-insensitive) + make + model + trim + year + vin.
 * Keeps only the oldest record per group.
 */
async function deduplicateInventory() {
  const duplicates = await inventoryRepository.aggregate([
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

    const result = await inventoryRepository.deleteMany({ _id: { $in: removeIds } });
    totalRemoved += result.deletedCount;
    removed.push({
      key: `${group._id.partName} | ${group._id.make} | ${group._id.model}`,
      removed: result.deletedCount,
      skippedForLiveLink: skippedForLiveLink.length,
    });
  }

  const remaining = await inventoryRepository.countDocuments();

  return {
    duplicateGroupsFound: duplicates.length,
    totalRemoved,
    totalSkippedLiveLinks,
    remaining,
    details: removed,
  };
}

module.exports = {
  createInventory,
  getInventoryByVIN,
  updateInventoryPrice,
  getAllInventories,
  getPartsMasterList,
  searchByMakeModelYear,
  exportInventories,
  initiateSyncInventoriesV3,
  deduplicateInventory,
};
