/**
 * Car Intake business logic. Extracted 1:1 from
 * controllers/carIntakeController.js (the largest single controller in the
 * codebase, ~2100 lines) during the clean-architecture migration — every
 * field-mapping rule, status-computation heuristic, towing-fee validation,
 * Excel bulk-import parsing rule, and print-document data assembly is
 * preserved exactly.
 *
 * KNOWN PRE-EXISTING BUG, PRESERVED VERBATIM (found during this audit, NOT
 * introduced by it — see the final migration report): the original
 * `bulkUploadScraped()`'s per-row processing block references three
 * variables that are never declared anywhere in that function — `carIntake`,
 * `transaction`, and `doc` (they exist only in the unrelated
 * printPaymentSlip/printAllDocuments functions above it in the same file —
 * this block reads like an accidental copy-paste fragment). Referencing an
 * undeclared identifier throws a ReferenceError, which the per-row try/catch
 * catches and records as a row failure — meaning `bulkUploadScraped` already
 * fails EVERY row on the `main` branch today; it does not currently import
 * any scraped records successfully. This migration's job is to preserve
 * existing behavior exactly, not to fix bugs discovered along the way, so
 * this dead/broken code path is carried over unchanged below (see
 * `buildScrapedRowData`).
 */
const xlsx = require("xlsx");
const fs = require("fs");
const path = require("path");

const carIntakeRepository = require("../repositories/carIntake.repository");
const sellerRepository = require("../repositories/seller.repository");
const transactionRepository = require("../repositories/transaction.repository");
const entryFeeRepository = require("../repositories/entryFee.repository");
const paymentSlipRepository = require("../repositories/paymentSlip.repository");

// Helper to normalize image values: accept string or object, return string (prefer url then filename)
const normalizeImageValue = (val) => {
  if (!val && val !== 0) return undefined;
  if (typeof val === "string") return val;
  if (typeof val === "object") {
    if (val.url) return val.url;
    if (val.filename) return val.filename;
    if (val.name) return val.name;
    try {
      return JSON.stringify(val);
    } catch (e) {
      return undefined;
    }
  }
  return String(val);
};

// Helper to detect payment presence (treat 0 and '0' as valid paid amounts)
const hasPaymentIn = (data) => {
  if (!data) return false;
  const pa = data.payment && data.payment.paidAmount;
  const topPa = data.paidAmount;
  const val = pa !== undefined ? pa : topPa;
  const hasPaid = val !== undefined && val !== null && val !== "" && !Number.isNaN(Number(val));

  const pm = data.payment && data.payment.paymentMethod;
  const topPm = data.paymentMethod;
  const method = pm !== undefined ? pm : topPm;
  const hasMethod = method !== undefined && method !== null && String(method).trim() !== "";

  return hasPaid || hasMethod;
};

// Strict parser for the optional Towing Fee.
// Returns undefined ONLY for intentionally omitted input; throws on invalid supplied input.
const parseOptionalTowingFee = (value) => {
  if (value === undefined || value === null) return undefined;
  const type = typeof value;
  if (type === "string") {
    if (value.trim() === "") return undefined;
  } else if (type !== "number") {
    throw new Error("Towing fee must be a valid number");
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("Towing fee must be a valid number");
  if (n < 0) throw new Error("Towing fee cannot be negative");
  return Math.round((n + Number.EPSILON) * 100) / 100;
};

// Non-throwing reader for render/snapshot paths. Reads already-validated stored
// data defensively and never coerces raw user input.
const readTowingFee = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
};

// Determine status based on which step data is present
const computeStatusFrom = (data) => {
  try {
    const enumValues = carIntakeRepository.raw().schema.path("status").enumValues || [];
    if (data && data.status && enumValues.includes(data.status)) return data.status;
  } catch (e) {
    // ignore and compute
  }

  if (hasPaymentIn(data)) return "payment-done";

  if (data && data.kyc && data.kyc.seller) return "kyc-uploaded";

  if (data && data.price && (data.price.finalPrice || data.price.ourPrice || data.price.actualPrice)) return "price-uploaded";

  if (data && data.parts) {
    const p = data.parts;
    const partKeys = Object.keys(p || {}).filter((k) => k !== "partsUploadedBy" && k !== "partsDescription");
    for (const k of partKeys) {
      const v = p[k];
      if (v && (v.selected === true || (v.unit && v.unit > 0) || typeof v === "string")) return "parts-uploaded";
    }
  }

  if (data && data.imagesStep) {
    const imgs = data.imagesStep;
    const imgKeys = [
      "image1", "image2", "image3", "image4", "image5", "image6", "image7", "image8",
      "engineImage", "bootImage", "belowVehicleImage", "fullVehicleImage",
    ];
    for (const k of imgKeys) if (imgs[k]) return "images-uploaded";
  }

  if (data && data.carDetails) {
    const cd = data.carDetails;
    if (cd.make || cd.model || cd.year) return "details-uploaded";
  }

  if (data && data.vin) return "vin-fetched";

  return "intake";
};

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  err.plainText = true;
  return err;
}

async function createCarIntake(formData, userId) {
  console.log("Received car intake data:", formData);

  formData.vin = String(formData.vin || "").trim().toUpperCase();

  formData.manualVinMode = formData.manualVinMode === true || formData.manualVinMode === "true" || formData.vin.length < 17;

  formData.year = formData.year ? Number(formData.year) : undefined;

  formData.make = formData.make?.toString().trim() || undefined;
  formData.model = formData.model?.toString().trim() || undefined;
  formData.trim = formData.trim?.toString().trim() || undefined;
  formData.color = formData.color?.toString().trim() || undefined;
  formData.bodyClass = formData.bodyClass?.toString().trim() || undefined;
  formData.fuelType = formData.fuelType?.toString().trim() || undefined;

  const allowedDrive = ["2WD", "4WD", "AWD", "FWD"];
  if (!allowedDrive.includes(formData.drive)) {
    formData.drive = "FWD";
  }

  const allowedTransmission = ["Automatic", "Manual"];
  if (!allowedTransmission.includes(formData.transmission)) {
    formData.transmission = "Automatic";
  }

  let sellerId = formData.sellerId || formData.seller;

  if (sellerId && !/^[0-9a-fA-F]{24}$/.test(sellerId)) {
    throw badRequestError("Invalid seller ObjectId format");
  }

  const carIntakeData = {
    vin: formData.vin || "",
    vinDetails: formData.vinDetails || {},
    carDetails: {
      year: parseInt(formData.year) || undefined,
      make: formData.make || undefined,
      model: formData.model || undefined,
      trim: formData.trim || undefined,
      color: formData.color || undefined,
      bodyClass: formData.bodyClass || undefined,
      chassisNo: formData.chassisNo || undefined,
      engine: formData.engine || formData.engineNo || undefined,
      engineVariant: formData.engineVariant || undefined,
      drive: formData.drive || undefined,
      transmission: formData.transmission || undefined,
      scrapYardName: formData.scrapYardName || undefined,
      scrapYardLocation: formData.scrapYardLocation || undefined,
      fuelType: formData.fuelType || undefined,
      keys: (() => {
        const raw = formData.keys !== undefined ? formData.keys : formData.hasKeys;
        const v = raw;
        if (typeof v === "boolean") return v;
        if (typeof v === "number") return v === 1;
        if (typeof v === "string") {
          const s = v.trim().toLowerCase();
          return s === "true" || s === "1" || s === "on";
        }
        return undefined;
      })(),
      weight: (() => {
        const w = formData.weight;
        if (w === undefined || w === "") return undefined;

        const vinDetails = formData.vinDetails || {};
        const min = vinDetails.weightMin;
        const max = vinDetails.weightMax;

        const numW = parseFloat(w);

        if (!Number.isNaN(numW)) {
          if (min !== undefined && numW < min) {
            throw new Error(`Weight ${numW} lbs is below the valid range for this vehicle Class (< ${min}).`);
          }
          if (max !== undefined && numW > max) {
            throw new Error(`Weight ${numW} lbs is above the valid range for this vehicle Class (> ${max}).`);
          }
          return String(numW);
        }
        return String(w);
      })(),
      dimensions: formData.dimensions || undefined,
      description: formData.description || undefined,
      carDetailsUploadedBy: userId,
    },

    imagesStep: (() => {
      const defaults = {
        image1: undefined, image2: undefined, image3: undefined, image4: undefined,
        image5: undefined, image6: undefined, image7: undefined, image8: undefined,
        engineImage: undefined, bootImage: undefined, belowVehicleImage: undefined, fullVehicleImage: undefined,
        imageDescription: formData.imageDescription || undefined,
      };
      const incoming = formData.carImages || {};
      const keyMap = {
        carImage1: "image1", carImage2: "image2", carImage3: "image3", carImage4: "image4",
        carImage5: "image5", carImage6: "image6", carImage7: "image7", carImage8: "image8",
        carEngineImage: "engineImage", carBootImage: "bootImage",
        belowVehicleImage: "belowVehicleImage", fullVehicleImage: "fullVehicleImage",
        imageDescription: "imageDescription",
      };
      Object.keys(keyMap).forEach((inKey) => {
        if (incoming[inKey] !== undefined) {
          defaults[keyMap[inKey]] = normalizeImageValue(incoming[inKey]);
        }
      });
      return defaults;
    })(),

    partDetails: {
      parts: formData.partDetails?.parts || formData.parts || formData.diagnosis || {},
      partsDescription: formData.partDetails?.partsDescription || formData.partsDescription || undefined,
      partsUploadedBy: userId,
    },

    price: {
      towingFee: parseOptionalTowingFee(formData.towingFee),
      actualWeight: formData.actualWeight !== undefined ? parseFloat(formData.actualWeight) : undefined,
      ratePerPound: formData.ratePerPound !== undefined ? parseFloat(formData.ratePerPound) : undefined,
      actualPrice: formData.actualPrice !== undefined ? parseFloat(formData.actualPrice) : undefined,
      ourPrice: formData.ourPrice !== undefined ? parseFloat(formData.ourPrice) : undefined,
      customerPrice: formData.customerPrice !== undefined ? parseFloat(formData.customerPrice) : undefined,
      negotiateTo: formData.negotiateTo || undefined,
      finalPrice: formData.finalPrice !== undefined ? parseFloat(formData.finalPrice) : undefined,
      priceDescription: formData.priceDescription || undefined,
      priceUploadedBy: userId,
    },

    kyc: {
      seller: sellerId || undefined,
      sellingDate: formData.sellingDate || undefined,
      pickupType: formData.pickupType || undefined,
      vehicleSource: formData.vehicleSource || undefined,
      documents: formData.documents || {},
      sellerSignature: formData.sellerSignature || undefined,
      kycDescription: formData.kycDescription || undefined,
      kycUploadedBy: userId,
    },

    payment: {
      paymentMethod: formData.paymentMethod || undefined,
      paidAmount: formData.paidAmount !== undefined ? parseFloat(formData.paidAmount) : undefined,
      paymentDescription: formData.paymentDescription || undefined,
      paymentBy: userId,
    },
    seller: sellerId || undefined,
    manualVinMode: formData.manualVinMode,
    createdBy: userId,
  };

  try {
    const enumValues = carIntakeRepository.raw().schema.path("status").enumValues || [];
    if (formData.status && enumValues.includes(formData.status)) {
      carIntakeData.status = formData.status;
    } else {
      carIntakeData.status = computeStatusFrom(carIntakeData);
    }
  } catch (e) {
    carIntakeData.status = computeStatusFrom(carIntakeData);
  }

  carIntakeData.imagesStep.imagesUploadedBy = userId;

  if (carIntakeData.vin) {
    const existing = await carIntakeRepository.findOne({ vin: carIntakeData.vin }).populate("createdBy", "first_name last_name email");
    if (existing) {
      return { alreadyExisted: true, carIntake: existing };
    }
  }

  const carIntake = carIntakeRepository.build(carIntakeData);
  await carIntakeRepository.save(carIntake);

  const populatedCarIntake = await carIntakeRepository
    .findById(carIntake._id)
    .populate("kyc.seller", "firstName lastName email mobileNo driversLicense description")
    .populate("createdBy", "first_name last_name email");

  return { alreadyExisted: false, carIntake: populatedCarIntake };
}

async function getCarIntakes(query) {
  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 10;
  const skip = (page - 1) * limit;

  const filter = { isActive: true, isDeleted: { $ne: true } };
  if (query.status) {
    const raw = query.status;
    let statuses = [];
    if (Array.isArray(raw)) {
      statuses = raw.map((s) => String(s || "")).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
    } else {
      statuses = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
    }

    if (statuses.length === 1) filter.status = statuses[0];
    else if (statuses.length > 1) filter.status = { $in: statuses };
  }
  if (!filter.status && query.excludeStatus) {
    const raw = query.excludeStatus;
    const excludes = Array.isArray(raw)
      ? raw.map((s) => String(s || "")).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean)
      : String(raw).split(",").map((s) => s.trim()).filter(Boolean);
    if (excludes.length) filter.status = { $nin: excludes };
  }
  if (query.make) {
    filter.make = new RegExp(query.make, "i");
  }
  if (query.year) {
    filter.year = query.year;
  }
  if (query.search) {
    const searchTerm = String(query.search).trim();
    if (searchTerm.length) {
      const re = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

      let sellerIds = [];
      try {
        const sellers = await sellerRepository.find({ $or: [{ email: re }, { firstName: re }, { lastName: re }, { mobileNo: re }] }).select("_id");
        sellerIds = (sellers || []).map((s) => s._id);
      } catch (e) {
        sellerIds = [];
      }

      const orArray = [{ vin: re }, { "carDetails.make": re }, { "carDetails.model": re }, { "carDetails.trim": re }];
      if (sellerIds.length) orArray.push({ seller: { $in: sellerIds } });

      filter.$or = orArray;
    }
  }

  const carIntakes = await carIntakeRepository
    .find(filter)
    .populate("kyc.seller", "firstName lastName email mobileNo driversLicense description")
    .populate("createdBy", "first_name last_name email")
    .populate("scrapedBy", "first_name last_name email")
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const total = await carIntakeRepository.countDocuments(filter);

  return { carIntakes, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}

async function getCarIntake(id) {
  const carIntake = await carIntakeRepository
    .findOne({ _id: id, isDeleted: { $ne: true } })
    .populate("kyc.seller", "firstName lastName email mobileNo signatureImage description")
    .populate("createdBy", "first_name last_name email");

  if (!carIntake) {
    const err = new Error("Car intake not found");
    err.statusCode = 404;
    throw err;
  }

  const transaction = await transactionRepository.findOne({ carIntake: carIntake._id });

  return { carIntake, transaction };
}

async function updateCarIntake(id, body, userId) {
  const { sellerData, transactionData, ...carIntakeData } = body;

  const carIntake = await carIntakeRepository.findById(id);
  if (!carIntake) {
    const err = new Error("Car intake not found");
    err.statusCode = 404;
    throw err;
  }

  let sellerId = carIntakeData.sellerId || carIntakeData.seller;

  if (sellerId) {
    if (!/^[0-9a-fA-F]{24}$/.test(sellerId)) {
      throw badRequestError("Invalid seller ObjectId format");
    }
    carIntake.seller = sellerId;
    carIntake.kyc = carIntake.kyc || {};
    carIntake.kyc.seller = sellerId;
  }

  const cdFields = [
    "year", "make", "model", "trim", "color", "bodyClass", "chassisNo", "engine",
    "engineVariant", "drive", "transmission", "scrapYardName", "scrapYardLocation",
    "fuelType", "keys", "weight", "dimensions", "description",
  ];
  let anyCd = false;
  cdFields.forEach((f) => {
    if (carIntakeData[f] !== undefined) {
      carIntake.carDetails = carIntake.carDetails || {};

      if (f === "weight") {
        const w = carIntakeData[f];
        if (w !== "") {
          const numW = parseFloat(w);
          const vinDetails = carIntake.vinDetails || {};
          const min = vinDetails.weightMin;
          const max = vinDetails.weightMax;

          if (!Number.isNaN(numW)) {
            if (min !== undefined && numW < min) {
              throw new Error(`Weight ${numW} lbs is below the valid range for this vehicle Class (< ${min}).`);
            }
            if (max !== undefined && numW > max) {
              throw new Error(`Weight ${numW} lbs is above the valid range for this vehicle Class (> ${max}).`);
            }
            carIntake.carDetails[f] = String(numW);
          } else {
            carIntake.carDetails[f] = w;
          }
        } else {
          carIntake.carDetails[f] = w;
        }
      } else {
        carIntake.carDetails[f] = carIntakeData[f];
      }
      anyCd = true;
    }
  });
  if (anyCd) {
    carIntake.carDetails = carIntake.carDetails || {};
    carIntake.carDetails.carDetailsUploadedBy = userId;
  }

  if (carIntakeData.carImages) {
    carIntake.imagesStep = carIntake.imagesStep || {};
    const incomingImgs = carIntakeData.carImages || {};
    const keyMap = {
      carImage1: "image1", carImage2: "image2", carImage3: "image3", carImage4: "image4",
      carImage5: "image5", carImage6: "image6", carImage7: "image7", carImage8: "image8",
      carEngineImage: "engineImage", carBootImage: "bootImage",
      belowVehicleImage: "belowVehicleImage", fullVehicleImage: "fullVehicleImage",
      imageDescription: "imageDescription",
    };
    Object.keys(keyMap).forEach((inKey) => {
      if (incomingImgs[inKey] !== undefined) {
        carIntake.imagesStep[keyMap[inKey]] = normalizeImageValue(incomingImgs[inKey]);
      }
    });
    carIntake.imagesStep.imagesUploadedBy = userId;
  }

  if (carIntakeData.parts) {
    carIntake.parts = Object.assign(carIntake.parts || {}, carIntakeData.parts);
    carIntake.parts.partsUploadedBy = userId;
  }

  if (carIntakeData.parts || carIntakeData.partsDescription) {
    carIntake.partDetails = carIntake.partDetails || {};
    carIntake.partDetails.parts =
      carIntakeData.partDetails?.parts || carIntakeData.parts || carIntakeData.diagnosis || carIntake.partDetails.parts || {};
    carIntake.partDetails.partsDescription =
      carIntakeData.partDetails?.partsDescription || carIntakeData.partsDescription || carIntake.partDetails.partsDescription;
    carIntake.partDetails.partsUploadedBy = userId;
  }

  const priceFields = ["actualWeight", "ratePerPound", "actualPrice", "ourPrice", "customerPrice", "negotiateTo", "finalPrice", "priceDescription"];
  let anyPrice = false;
  carIntake.price = carIntake.price || {};

  if (carIntakeData.towingFee !== undefined) {
    const parsedTowingFee = parseOptionalTowingFee(carIntakeData.towingFee); // throws badRequestError-shaped Error on invalid input — caller (controller) maps to 400 exactly like original
    carIntake.price.towingFee = parsedTowingFee;
    anyPrice = true;
  }

  priceFields.forEach((f) => {
    if (carIntakeData[f] !== undefined) {
      carIntake.price[f] = carIntakeData[f];
      anyPrice = true;
    }
  });
  if (anyPrice) {
    carIntake.price = carIntake.price || {};
    carIntake.price.priceUploadedBy = userId;
  }

  const kycFields = ["sellingDate", "pickupType", "vehicleSource", "documents", "sellerSignature", "kycDescription"];
  let anyKyc = false;
  carIntake.kyc = carIntake.kyc || {};
  kycFields.forEach((f) => {
    if (carIntakeData[f] !== undefined) {
      if (f === "documents") carIntake.kyc.documents = carIntakeData.documents;
      else carIntake.kyc[f] = carIntakeData[f];
      anyKyc = true;
    }
  });
  if (anyKyc) {
    carIntake.kyc = carIntake.kyc || {};
    carIntake.kyc.kycUploadedBy = userId;
  }

  const payFields = ["paymentMethod", "paidAmount", "paymentDescription"];
  let anyPay = false;
  carIntake.payment = carIntake.payment || {};
  payFields.forEach((f) => {
    if (carIntakeData[f] !== undefined) {
      if (f === "paidAmount") carIntake.payment.paidAmount = carIntakeData.paidAmount;
      else if (f === "paymentDescription") carIntake.payment.paymentDescription = carIntakeData.paymentDescription;
      else carIntake.payment.paymentMethod = carIntakeData.paymentMethod;
      anyPay = true;
    }
  });
  if (anyPay) {
    carIntake.payment = carIntake.payment || {};
    carIntake.payment.paymentBy = userId;
  }

  const allowedTopLevel = ["vin", "vinDetails", "status", "isActive", "createdBy", "manualVinMode"];
  Object.keys(carIntakeData).forEach((k) => {
    if (allowedTopLevel.includes(k)) {
      if (k === "status") {
        try {
          const enumValues = carIntakeRepository.raw().schema.path("status").enumValues || [];
          if (enumValues.includes(carIntakeData.status)) carIntake.status = carIntakeData.status;
        } catch (e) {
          // ignore
        }
      } else {
        carIntake[k] = carIntakeData[k];
      }
    }
  });

  try {
    const enumValues = carIntakeRepository.raw().schema.path("status").enumValues || [];
    const merged = Object.assign({}, carIntake.toObject(), {});
    const computed = computeStatusFrom(merged);

    if (carIntakeData.status && enumValues.includes(carIntakeData.status)) {
      carIntake.status = carIntakeData.status;
    } else {
      carIntake.status = computed;
    }
  } catch (e) {
    // ignore and keep existing status
  }

  await carIntakeRepository.save(carIntake);

  const incomingPaid = carIntakeData.paidAmount !== undefined ? carIntakeData.paidAmount : carIntakeData.payment && carIntakeData.payment.paidAmount;
  const incomingMethod =
    carIntakeData.paymentMethod !== undefined ? carIntakeData.paymentMethod : carIntakeData.payment && carIntakeData.payment.paymentMethod;
  const incomingDesc =
    carIntakeData.paymentDescription !== undefined
      ? carIntakeData.paymentDescription
      : carIntakeData.payment && carIntakeData.payment.paymentDescription;

  // Car Intake vehicle purchase: NO tax. The authoritative business amount is
  // carIntake.price.finalPrice and it must remain the exact gross vehicle
  // purchase amount. We therefore create the Transaction with taxRate 0 and
  // amountIsNet false so the Transaction model's tax hook leaves
  // amount === finalPrice, taxAmount === 0 and netAmount === finalPrice (no
  // tax generated/deducted for this flow).
  const purchaseAmount = carIntake.price?.finalPrice ?? incomingPaid ?? 0;

  if (
    (transactionData || incomingPaid !== undefined || incomingMethod !== undefined) &&
    !(await transactionRepository.findOne({ carIntake: carIntake._id }))
  ) {
    const tx = transactionRepository.build({
      type: "debit",
      amount: purchaseAmount,
      amountIsNet: false,
      taxRate: 0,
      paymentMethod: incomingMethod ?? carIntake.payment?.paymentMethod,
      description: incomingDesc ?? carIntake.payment?.paymentDescription,
      carIntake: carIntake._id,
      seller: carIntake.seller,
      status: "completed",
      createdBy: userId,
      ...transactionData,
      amount: purchaseAmount,
      amountIsNet: false,
      taxRate: 0,
    });
    await transactionRepository.save(tx);
  }

  if (transactionData || incomingPaid !== undefined || incomingMethod !== undefined || incomingDesc !== undefined) {
    await transactionRepository.findOneAndUpdate(
      { carIntake: carIntake._id },
      {
        amount: purchaseAmount,
        amountIsNet: false,
        taxRate: 0,
        paymentMethod: incomingMethod ?? carIntake.payment?.paymentMethod,
        description: incomingDesc ?? carIntake.payment?.paymentDescription,
        ...transactionData,
        amount: purchaseAmount,
        amountIsNet: false,
        taxRate: 0,
      }
    );
  }

  return carIntakeRepository
    .findById(carIntake._id)
    .populate("kyc.seller", "firstName lastName email mobileNo driversLicense description")
    .populate("createdBy", "first_name last_name email");
}

async function deleteCarIntake(id) {
  const carIntake = await carIntakeRepository.findById(id);
  if (!carIntake) {
    const err = new Error("Car intake not found");
    err.statusCode = 404;
    throw err;
  }

  carIntake.isActive = false;
  carIntake.isDeleted = true;
  carIntake.deletedAt = new Date();
  await carIntakeRepository.save(carIntake);

  await transactionRepository.updateMany({ carIntake: carIntake._id }, { isActive: false, isDeleted: true, deletedAt: new Date() });
}

async function updateCarIntakeStatus(id, status, userId) {
  const enumValues = carIntakeRepository.raw().schema.path("status").enumValues || [];
  if (!enumValues.includes(status)) {
    throw badRequestError("Invalid status");
  }

  const update = { status };
  if (status === "scraped") {
    update.scrapedBy = userId;
    update.scrapDate = new Date();
  }

  const carIntake = await carIntakeRepository
    .findByIdAndUpdate(id, update, { new: true })
    .populate("kyc.seller", "firstName lastName email mobileNo driversLicense description")
    .populate("scrapedBy", "first_name last_name email");

  if (!carIntake) {
    const err = new Error("Car intake not found");
    err.statusCode = 404;
    throw err;
  }

  return carIntake;
}

// "Move to Ready-to-Scrap" API by shiva
async function moveToReadyToScrap(id) {
  const updated = await carIntakeRepository.findByIdAndUpdate(id, { $set: { status: "ready-to-scrap" } }, { new: true });

  if (!updated) {
    const err = new Error("Car not found");
    err.statusCode = 404;
    throw err;
  }

  return updated;
}

// moveToScrapped function by shiva
async function moveToScrapped(id, scrapRemarks, userId) {
  return carIntakeRepository.findByIdAndUpdate(
    id,
    { status: "scraped", scrapedBy: userId, scrapDate: new Date(), scrapRemarks },
    { new: true }
  );
}

async function getCarIntakeStats(query) {
  const { startDate, endDate } = query;

  const matchStage = { isActive: true };
  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = new Date(startDate);
    if (endDate) matchStage.createdAt.$lte = new Date(endDate);
  }

  const stats = await carIntakeRepository.aggregate([
    { $match: matchStage },
    { $group: { _id: "$status", count: { $sum: 1 }, totalValue: { $sum: "$finalPrice" }, averageValue: { $avg: "$finalPrice" } } },
  ]);

  const totalCount = await carIntakeRepository.countDocuments(matchStage);
  const totalValue = await carIntakeRepository.aggregate([{ $match: matchStage }, { $group: { _id: null, total: { $sum: "$finalPrice" } } }]);

  return { stats, summary: { totalCount, totalValue: totalValue[0]?.total || 0 } };
}

/**
 * Shared by printPaymentSlip and printAllDocuments: finds or creates the
 * PaymentSlip snapshot for a car intake. Byte-for-byte identical logic
 * duplicated in both original functions — consolidated here as pure
 * duplication removal, not a behavior change.
 */
async function findOrCreatePaymentSlip(carIntake, transaction, userId) {
  let paymentSlipDoc = null;
  try {
    paymentSlipDoc = await paymentSlipRepository
      .findOne({ carIntake: carIntake._id })
      .sort({ createdAt: -1 })
      .populate("transaction")
      .populate("createdBy", "first_name last_name email");

    if (!paymentSlipDoc) {
      // Car Intake vehicle purchase: NO tax. finalPrice IS the actual gross
      // vehicle purchase amount; no gross = finalPrice / (1 - taxRate)
      // derivation is performed.
      const slipPurchaseAmount = carIntake.price?.finalPrice || 0;

      const slipData = {
        amount: slipPurchaseAmount,
        grossAmount: slipPurchaseAmount,
        netAmount: slipPurchaseAmount,
        taxRate: 0,
        taxAmount: 0,
        paymentMethod: (transaction && transaction.paymentMethod) || carIntake.payment?.paymentMethod,
        paymentDescription: (transaction && transaction.description) || carIntake.payment?.paymentDescription,
        carSnapshot: carIntake.toObject(),
        transactionSnapshot: transaction ? transaction.toObject() : null,
      };

      const created = await paymentSlipRepository.create({
        carIntake: carIntake._id,
        transaction: transaction?._id,
        slipData,
        paymentMethod: slipData.paymentMethod,
        grossAmount: Math.round((slipPurchaseAmount + Number.EPSILON) * 100) / 100,
        netAmount: Math.round((slipPurchaseAmount + Number.EPSILON) * 100) / 100,
        taxRate: 0,
        taxAmount: 0,
        paymentDate: transaction?.createdAt || new Date(),
        createdBy: userId,
      });

      paymentSlipDoc = await paymentSlipRepository.findById(created._id).populate("transaction").populate("createdBy", "first_name last_name email");
    }
  } catch (e) {
    console.warn("PaymentSlip creation/check failed:", e && e.message);
    paymentSlipDoc = null;
  }

  return paymentSlipDoc;
}

function loadLogoDataUri() {
  try {
    const logoPath = path.join(__dirname, "..", "assets", "logo-sm1.png");
    if (fs.existsSync(logoPath)) {
      const buf = fs.readFileSync(logoPath);
      return `data:image/png;base64,${buf.toString("base64")}`;
    }
  } catch (e) {
    console.warn("Could not read logo for payment slip:", e && e.message);
  }
  return null;
}

async function buildPrintPaymentSlipData(id, reqUser) {
  const carIntake = await carIntakeRepository
    .findOne({ _id: id, isDeleted: { $ne: true } })
    .populate("kyc.seller", "firstName lastName email mobileNo signatureImage description")
    .populate("createdBy", "first_name last_name email");

  if (!carIntake) throw notFoundError("Car intake not found");

  const transaction = await transactionRepository
    .findOne({ carIntake: carIntake._id, isActive: true })
    .sort({ createdAt: -1 })
    .populate("createdBy", "first_name last_name email");

  const paymentSlipDoc = await findOrCreatePaymentSlip(carIntake, transaction, reqUser?._id);
  const logoDataUri = loadLogoDataUri();

  const slipPadded = paymentSlipDoc && paymentSlipDoc.slipNumber ? String(paymentSlipDoc.slipNumber).padStart(7, "0") : null;

  // Vehicle Purchase Amount = the actual gross vehicle purchase amount.
  // Source of truth is carIntake.price.finalPrice; fall back only if absent.
  // Never use a tax-derived value (transaction.netAmount / grossAmount) for P.
  const purchaseAmount = carIntake.price?.finalPrice ?? paymentSlipDoc?.netAmount ?? transaction?.amount ?? 0;

  return {
    carIntake,
    transaction,
    paymentSlip: paymentSlipDoc,
    slipPadded,
    generatedAt: new Date(),
    generatedBy: reqUser ? { id: reqUser._id, name: reqUser.first_name || reqUser.name || "" } : null,
    logoSrc: logoDataUri || "/assets/logo-sm1.png",
    adjustedEntryFee: (await entryFeeRepository.findOne().sort({ createdAt: -1 }))?.entryFee || 2.0,
    purchaseAmount,
    towingFee: readTowingFee(carIntake.price?.towingFee),
  };
}

async function buildPrintAllDocumentsData(id, reqUser) {
  const carIntake = await carIntakeRepository
    .findOne({ _id: id, isDeleted: { $ne: true } })
    .populate("kyc.seller", "firstName lastName email mobileNo signatureImage description")
    .populate("createdBy", "first_name last_name email");

  if (!carIntake) throw notFoundError("Car intake not found");

  const transaction = await transactionRepository
    .findOne({ carIntake: carIntake._id, isActive: true })
    .sort({ createdAt: -1 })
    .populate("createdBy", "first_name last_name email");

  const paymentSlipDoc = await findOrCreatePaymentSlip(carIntake, transaction, reqUser?._id);
  const logoDataUri = loadLogoDataUri();

  // Handle documents - collect all available documents
  // Priority order: Title Certificate, DL Document, Physical Paper
  const documents = [];
  const docPriorities = [
    { key: "titleCertificate", title: "Title Certificate" },
    { key: "driversLicense", title: "Driver's License" },
    { key: "physicalPaper", title: "Physical Paper" },
  ];

  try {
    const docs = carIntake?.kyc?.documents || {};

    for (const { key, title } of docPriorities) {
      let docPath = docs[key];
      if (docPath) {
        let filename = docPath;
        if (filename.includes("uploads/")) {
          filename = filename.substring(filename.lastIndexOf("uploads/") + 8);
        } else if (filename.includes("/")) {
          filename = path.basename(filename);
        }

        const filePath = path.join(__dirname, "..", "uploads", filename);

        if (fs.existsSync(filePath)) {
          try {
            const buf = fs.readFileSync(filePath);
            const ext = path.extname(filename).toLowerCase();

            const mimeTypes = {
              ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
            };

            const mimeType = mimeTypes[ext] || "image/jpeg";
            const b64 = buf.toString("base64");
            const dataUri = `data:${mimeType};base64,${b64}`;

            documents.push({ title, dataUri });
          } catch (readErr) {
            console.warn(`Failed to read document ${filename}:`, readErr.message);
          }
        } else {
          console.warn(`Document file not found: ${filePath} for car intake ${id}`);
        }
      }
    }
  } catch (e) {
    console.warn("Could not read documents for combined print:", e && e.message);
  }

  const slipPadded = paymentSlipDoc && paymentSlipDoc.slipNumber ? String(paymentSlipDoc.slipNumber).padStart(7, "0") : null;

  const purchaseAmount = carIntake.price?.finalPrice ?? paymentSlipDoc?.netAmount ?? transaction?.amount ?? 0;

  return {
    carIntake,
    transaction,
    paymentSlip: paymentSlipDoc,
    slipPadded,
    generatedAt: new Date(),
    generatedBy: reqUser ? { id: reqUser._id, name: reqUser.first_name || reqUser.name || "" } : null,
    logoSrc: logoDataUri || "/assets/logo-sm1.png",
    documents,
    adjustedEntryFee: (await entryFeeRepository.findOne().sort({ createdAt: -1 }))?.entryFee || 2.0,
    purchaseAmount,
    towingFee: readTowingFee(carIntake.price?.towingFee),
  };
}

async function bulkUploadCarIntakes(fileUrl, userId, manualVinMode) {
  if (!fileUrl) {
    throw badRequestError("No file URL provided");
  }

  const filename = fileUrl.replace(/^\/uploads\//, "");
  const filePath = path.join(__dirname, "..", "uploads", filename);

  if (!fs.existsSync(filePath)) {
    const err = new Error("File not found");
    err.statusCode = 404;
    throw err;
  }

  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = xlsx.utils.sheet_to_json(worksheet);

  if (!data || data.length === 0) {
    throw badRequestError("Excel file is empty");
  }

  const results = { successful: [], failed: [], skipped: [] };

  const vinsToCheck = data
    .map((row) => {
      const vin = row.vin || row.VIN;
      return vin ? vin.toString().trim().toUpperCase() : null;
    })
    .filter(Boolean);

  const existingVins = await carIntakeRepository.find({ vin: { $in: vinsToCheck } }).select("vin").lean();
  const existingVinSet = new Set(existingVins.map((v) => v.vin));

  const carIntakesToInsert = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowNumber = i + 2;

    try {
      const make = row.Make || row.make;
      const model = row.Modal || row.Model || row.model;
      const year = row.Year || row.year;
      const trim = row.trim || row.Trim;
      const vin = row.vin || row.VIN;
      const color = row.color || row.Color;
      const bodyClass = row["Boday Class"] || row["Body Class"] || row.bodyClass;
      const engine = row.Engine || row.engine;
      const transmission = row.Transmission || row.transmission;
      const drive = row.Drive || row.drive;
      const fuelType = row["Fuel type"] || row["Fuel Type"] || row.fuelType;
      const where = row.Where || row.where || row.Location;
      const keys = row.Keys || row.keys;
      const dateIn = row["date In"] || row["Date In"] || row.dateIn;

      if (!vin) {
        results.skipped.push({ row: rowNumber, reason: "Missing required field: VIN", data: row });
        continue;
      }

      const normalizedVin = vin.toString().trim().toUpperCase();

      if (existingVinSet.has(normalizedVin)) {
        results.skipped.push({ row: rowNumber, reason: "VIN already exists", vin: normalizedVin });
        continue;
      }

      let hasKeys = undefined;
      if (keys !== undefined && keys !== null && keys !== "") {
        const keysStr = keys.toString().trim().toLowerCase();
        hasKeys = keysStr === "yes" || keysStr === "true" || keysStr === "1" || keysStr === "on";
      }

      let parsedDrive = undefined;
      if (drive) {
        const driveStr = drive.toString().trim().toUpperCase();
        const validDriveValues = ["2WD", "4WD", "AWD", "FWD"];
        if (validDriveValues.includes(driveStr)) {
          parsedDrive = driveStr;
        }
      }

      let parsedTransmission = undefined;
      if (transmission) {
        const transStr = transmission.toString().trim();
        const validTransmissionValues = ["Automatic", "Manual"];
        const matchedTrans = validTransmissionValues.find((v) => v.toLowerCase() === transStr.toLowerCase());
        if (matchedTrans) {
          parsedTransmission = matchedTrans;
        }
      }

      let createdAtDate = undefined;
      if (dateIn) {
        try {
          if (typeof dateIn === "number") {
            const excelEpoch = new Date(1899, 11, 30);
            createdAtDate = new Date(excelEpoch.getTime() + dateIn * 86400000);
          } else {
            createdAtDate = new Date(dateIn);
          }

          if (isNaN(createdAtDate.getTime())) {
            createdAtDate = undefined;
          }
        } catch (err) {
          createdAtDate = undefined;
        }
      }

      const carIntakeData = {
        vin: normalizedVin,
        manualVinMode, // added by shiva — from the request body, not the Excel row
        carDetails: {
          year: year ? parseInt(year) : undefined,
          make: make ? make.toString().trim() : undefined,
          model: model ? model.toString().trim() : undefined,
          trim: trim ? trim.toString().trim() : undefined,
          color: color ? color.toString().trim() : undefined,
          bodyClass: bodyClass ? bodyClass.toString().trim() : undefined,
          engine: engine ? engine.toString().trim() : undefined,
          transmission: parsedTransmission,
          drive: parsedDrive,
          fuelType: fuelType ? fuelType.toString().trim() : undefined,
          keys: hasKeys,
          scrapYardLocation: where ? where.toString().trim() : undefined,
          carDetailsUploadedBy: userId,
        },
        status: "intake",
        createdBy: userId,
      };

      if (createdAtDate) {
        carIntakeData.createdAt = createdAtDate;
        carIntakeData.updatedAt = createdAtDate;
      }

      carIntakesToInsert.push({ data: carIntakeData, row: rowNumber });
    } catch (error) {
      console.error(`Error processing row ${rowNumber}:`, error);
      results.failed.push({ row: rowNumber, reason: error.message, data: row });
    }
  }

  if (carIntakesToInsert.length > 0) {
    try {
      const insertedDocs = await carIntakeRepository.insertMany(
        carIntakesToInsert.map((item) => item.data),
        { ordered: false }
      );

      insertedDocs.forEach((doc, index) => {
        const item = carIntakesToInsert[index];
        const cd = doc.carDetails || {};
        const carDesc = [cd.year, cd.make, cd.model].filter(Boolean).join(" ") || "Car";
        results.successful.push({ row: item.row, vin: doc.vin, car: carDesc, id: doc._id });
      });
    } catch (error) {
      if (error.name === "MongoBulkWriteError" && error.writeErrors) {
        error.insertedDocs?.forEach((doc, index) => {
          if (doc && doc._id) {
            const item = carIntakesToInsert[index];
            const cd = doc.carDetails || {};
            const carDesc = [cd.year, cd.make, cd.model].filter(Boolean).join(" ") || "Car";
            results.successful.push({ row: item.row, vin: doc.vin, car: carDesc, id: doc._id });
          }
        });

        error.writeErrors.forEach((writeError) => {
          const item = carIntakesToInsert[writeError.index];
          results.failed.push({
            row: item.row,
            reason: writeError.errmsg || writeError.err?.message || "Database insertion failed",
            data: item.data,
          });
        });
      } else {
        console.error("Bulk insert error:", error);
        carIntakesToInsert.forEach((item) => {
          results.failed.push({ row: item.row, reason: error.message || "Database insertion failed", data: item.data });
        });
      }
    }
  }

  return {
    summary: { total: data.length, successful: results.successful.length, failed: results.failed.length, skipped: results.skipped.length },
    results,
  };
}

/**
 * Builds the per-row data object for a "GONE" sheet row. PRESERVES THE
 * PRE-EXISTING BUG documented at the top of this file verbatim: references
 * `carIntake`, `transaction`, and `doc` — none of which are ever assigned in
 * this function (or anywhere in the original bulkUploadScraped) — this
 * throws a ReferenceError on every single row, exactly as it does on `main`
 * today. Not fixed, per this migration's "preserve existing behavior"
 * mandate — see the file-level comment for full context.
 */
function buildScrapedRowRenderAndInsertData(reqUser) {
  const generatedAt = new Date();
  const generatedAtStr = generatedAt.toLocaleString();
  // eslint-disable-next-line no-undef
  const transactionDateStr = transaction && transaction.transactionDate ? transaction.transactionDate.toLocaleString() : null;

  const data = {
    // eslint-disable-next-line no-undef
    carIntake,
    // eslint-disable-next-line no-undef
    transaction,
    generatedAtStr,
    transactionDateStr,
    generatedBy: reqUser ? { id: reqUser._id, name: reqUser.first_name || reqUser.name || "" } : null,
    // eslint-disable-next-line no-undef
    purchaseAmount: carIntake.price?.finalPrice ?? transaction?.amount ?? 0,
    // eslint-disable-next-line no-undef
    towingFee: readTowingFee(carIntake.price?.towingFee),
  };

  return data;
}

async function bulkUploadScraped(fileUrl, userId, reqUser) {
  if (!fileUrl) {
    throw badRequestError("No file URL provided");
  }

  const filename = fileUrl.replace(/^\/uploads\//, "");
  const filePath = path.join(__dirname, "..", "uploads", filename);

  if (!fs.existsSync(filePath)) {
    const err = new Error("File not found");
    err.statusCode = 404;
    throw err;
  }

  const workbook = xlsx.readFile(filePath);

  const sheetName = workbook.SheetNames.find((n) => String(n || "").toLowerCase() === "gone");

  if (!sheetName) {
    throw badRequestError("Sheet 'GONE' not found");
  }

  const worksheet = workbook.Sheets[sheetName];
  const data = xlsx.utils.sheet_to_json(worksheet, { raw: true });

  if (!data || data.length === 0) {
    throw badRequestError("GONE sheet is empty");
  }

  const results = { successful: [], failed: [], skipped: [] };

  const vinsToCheck = data
    .map((row) => {
      const vin = row.vin || row.VIN || row.VIN_NUMBER || row["VIN"];
      return vin ? String(vin).trim().toUpperCase() : null;
    })
    .filter(Boolean);

  const existing = await carIntakeRepository.find({ vin: { $in: vinsToCheck } }).select("vin").lean();
  const existingSet = new Set(existing.map((d) => d.vin));

  const toInsert = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowNumber = i + 2;
    try {
      const what =
        row["What Happen?"] || row["What Happend?"] || row["What Happened?"] || row.what || row.what_happen || row.what_happend || row.what_happened;

      let statusForRow = null;
      const whatMissing = what === undefined || what === null || String(what).trim() === "";

      if (whatMissing) {
        statusForRow = "intake";
      } else {
        const whatStr = String(what).trim().toLowerCase();
        if (whatStr.includes("crush") || whatStr.includes("crushed")) {
          statusForRow = "scraped";
        } else if (whatStr.includes("sold")) {
          statusForRow = "sold";
        } else if (whatStr.includes("tow") || whatStr.includes("towed")) {
          statusForRow = "towed";
        } else {
          results.skipped.push({ row: rowNumber, reason: "Unhandled 'What Happen?' value" });
          continue;
        }
      }

      const vin = row.vin || row.VIN || row.VIN_NUMBER || row["VIN"];
      if (!vin) {
        results.skipped.push({ row: rowNumber, reason: "Missing VIN" });
        continue;
      }

      const normalizedVin = String(vin).trim().toUpperCase();
      if (existingSet.has(normalizedVin)) {
        results.skipped.push({ row: rowNumber, reason: "VIN exists" });
        continue;
      }

      let createdAt = undefined;
      const dateIn = row["Date in"] || row["date In"] || row["Date In"] || row.dateIn || row["Date In "] || row["DateIn"];
      if (dateIn) {
        if (typeof dateIn === "number") {
          const excelEpoch = new Date(1899, 11, 30);
          createdAt = new Date(excelEpoch.getTime() + dateIn * 86400000);
        } else {
          const dt = new Date(dateIn);
          if (!isNaN(dt.getTime())) createdAt = dt;
        }
      }

      let scrapDate = undefined;
      const dateField = row.Date || row.date || row["Date "] || row["Scrap Date"];
      if (dateField) {
        if (typeof dateField === "number") {
          const excelEpoch = new Date(1899, 11, 30);
          scrapDate = new Date(excelEpoch.getTime() + dateField * 86400000);
        } else {
          const dt = new Date(dateField);
          if (!isNaN(dt.getTime())) scrapDate = dt;
        }
      }

      const carDetails = {
        year: row.Year || row.year || undefined,
        make: row.Make || row.make || undefined,
        model: row.Model || row.model || undefined,
        trim: row.Trim || row.trim || undefined,
        color: row.Color || row.color || undefined,
        carDetailsUploadedBy: userId,
      };

      if (statusForRow === "intake") {
        carDetails.scrapYardName = row["Scrap Yard"] || row.scrapYardName || "RTX";
        carDetails.scrapYardLocation = row["Scrap Yard Location"] || row.scrapYardLocation || "New Jersey";
      } else {
        if (row["Scrap Yard"] || row.scrapYardName) carDetails.scrapYardName = row["Scrap Yard"] || row.scrapYardName;
        if (row["Scrap Yard Location"] || row.scrapYardLocation) carDetails.scrapYardLocation = row["Scrap Yard Location"] || row.scrapYardLocation;
      }

      // ── PRE-EXISTING BUG, PRESERVED VERBATIM (see file-level comment) ──
      // The original code at this exact point references undeclared
      // `transaction`/`carIntake`/`doc` variables and calls `res.render(...)`
      // — neither `res` nor those variables exist in this function's scope.
      // That throws a ReferenceError on literal line 1, caught by the
      // try/catch below exactly like any other row-processing error, so
      // every row in the original ends up in `results.failed`. Reproducing
      // that exact throw here (rather than the original's non-existent
      // `res.render` call, which cannot exist outside an HTTP handler) is
      // the closest faithful equivalent: same effect (this row throws and
      // is caught below), same net behavior (bulkUploadScraped imports
      // zero rows, exactly as on main today).
      buildScrapedRowRenderAndInsertData(reqUser);
    } catch (err) {
      console.error(`Error processing GONE row ${rowNumber}:`, err);
      results.failed.push({ row: rowNumber, reason: err.message });
    }
  }

  if (toInsert.length > 0) {
    try {
      const inserted = await carIntakeRepository.insertMany(toInsert.map((t) => t.data), { ordered: false });

      inserted.forEach((d, idx) => {
        const item = toInsert[idx];
        results.successful.push({ row: item.row, vin: d.vin, id: d._id });
      });
    } catch (err) {
      if (err.name === "MongoBulkWriteError" && err.writeErrors) {
        err.insertedDocs?.forEach((d, idx) => {
          const item = toInsert[idx];
          results.successful.push({ row: item.row, vin: d.vin, id: d._id });
        });
        err.writeErrors.forEach((we) => {
          const item = toInsert[we.index];
          results.failed.push({ row: item.row, reason: we.errmsg || we.err?.message });
        });
      } else {
        console.error("Bulk insert GONE error:", err);
        toInsert.forEach((it) => results.failed.push({ row: it.row, reason: err.message }));
      }
    }
  }

  return {
    summary: { total: data.length, successful: results.successful.length, failed: results.failed.length, skipped: results.skipped.length },
    results,
  };
}

module.exports = {
  createCarIntake,
  getCarIntakes,
  getCarIntake,
  updateCarIntake,
  deleteCarIntake,
  updateCarIntakeStatus,
  moveToReadyToScrap,
  moveToScrapped,
  getCarIntakeStats,
  buildPrintPaymentSlipData,
  buildPrintAllDocumentsData,
  bulkUploadCarIntakes,
  bulkUploadScraped,
};
