const CarIntake = require("../models/carInTake.model");
const Seller = require("../models/Seller");
const Transaction = require("../models/Transaction");
const xlsx = require("xlsx");
const fs = require("fs");
const path = require("path");

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
  const hasPaid =
    val !== undefined &&
    val !== null &&
    val !== "" &&
    !Number.isNaN(Number(val));

  const pm = data.payment && data.payment.paymentMethod;
  const topPm = data.paymentMethod;
  const method = pm !== undefined ? pm : topPm;
  const hasMethod =
    method !== undefined && method !== null && String(method).trim() !== "";

  return hasPaid || hasMethod;
};

// Determine status based on which step data is present
const computeStatusFrom = (data) => {
  // prefer explicit status if provided and valid
  try {
    const enumValues = CarIntake.schema.path("status").enumValues || [];
    if (data && data.status && enumValues.includes(data.status))
      return data.status;
  } catch (e) {
    // ignore and compute
  }

  const has = (obj) => obj && Object.keys(obj).length > 0;

  // Payment done (highest priority)
  if (hasPaymentIn(data)) return "payment-done";

  // KYC provided
  if (data && data.kyc && data.kyc.seller) return "kyc-uploaded";

  // Price provided
  if (
    data &&
    data.price &&
    (data.price.finalPrice || data.price.ourPrice || data.price.actualPrice)
  )
    return "price-uploaded";

  // Parts/diagnosis provided
  if (data && data.parts) {
    const p = data.parts;
    const partKeys = Object.keys(p || {}).filter(
      (k) => k !== "partsUploadedBy" && k !== "partsDescription"
    );
    for (const k of partKeys) {
      const v = p[k];
      if (
        v &&
        (v.selected === true || (v.unit && v.unit > 0) || typeof v === "string")
      )
        return "parts-uploaded";
    }
  }

  // Images provided
  if (data && data.imagesStep) {
    const imgs = data.imagesStep;
    const imgKeys = [
      "image1",
      "image2",
      "image3",
      "image4",
      "image5",
      "image6",
      "image7",
      "image8",
      "engineImage",
      "bootImage",
      "belowVehicleImage",
      "fullVehicleImage",
    ];
    for (const k of imgKeys) if (imgs[k]) return "images-uploaded";
  }

  // Car details provided
  if (data && data.carDetails) {
    const cd = data.carDetails;
    if (cd.make || cd.model || cd.year) return "details-uploaded";
  }

  // VIN fetched
  if (data && data.vin) return "vin-fetched";

  return "intake";
};

// @desc    Create new car intake (with seller and transaction)
// @route   POST /api/car-intake
// @access  Private
const createCarIntake = async (req, res) => {
  try {
    console.log("Received car intake data:", req.body);

    const formData = req.body;

    // Seller is now ObjectId from Customer
    let sellerId = formData.sellerId || formData.seller;

    // Validate sellerId
    if (!sellerId) {
      return res
        .status(400)
        .json({ error: "Missing seller (customer) ObjectId" });
    }

    // Optionally, check if sellerId is a valid ObjectId
    if (!/^[0-9a-fA-F]{24}$/.test(sellerId)) {
      return res.status(400).json({ error: "Invalid seller ObjectId format" });
    }

    // Prepare car intake data (map flat form fields into nested step objects expected by model)
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
          const raw =
            formData.keys !== undefined ? formData.keys : formData.hasKeys;
          const v = raw;
          if (typeof v === "boolean") return v;
          if (typeof v === "number") return v === 1;
          if (typeof v === "string") {
            const s = v.trim().toLowerCase();
            return s === "true" || s === "1" || s === "on";
          }
          return undefined;
        })(),
        weight:
          formData.weight !== undefined ? String(formData.weight) : undefined,
        dimensions: formData.dimensions || undefined,
        description: formData.description || undefined,
        carDetailsUploadedBy: req.user?._id,
      },

      imagesStep: (() => {
        const defaults = {
          image1: undefined,
          image2: undefined,
          image3: undefined,
          image4: undefined,
          image5: undefined,
          image6: undefined,
          image7: undefined,
          image8: undefined,
          engineImage: undefined,
          bootImage: undefined,
          belowVehicleImage: undefined,
          fullVehicleImage: undefined,
          imageDescription: formData.imageDescription || undefined,
        };
        const incoming = formData.carImages || {};
        const keyMap = {
          carImage1: "image1",
          carImage2: "image2",
          carImage3: "image3",
          carImage4: "image4",
          carImage5: "image5",
          carImage6: "image6",
          carImage7: "image7",
          carImage8: "image8",
          carEngineImage: "engineImage",
          carBootImage: "bootImage",
          belowVehicleImage: "belowVehicleImage",
          fullVehicleImage: "fullVehicleImage",
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
        parts:
          formData.partDetails?.parts ||
          formData.parts ||
          formData.diagnosis ||
          {},
        partsDescription:
          formData.partDetails?.partsDescription ||
          formData.partsDescription ||
          undefined,
        partsUploadedBy: req.user?._id,
      },

      price: {
        actualWeight:
          formData.actualWeight !== undefined
            ? parseFloat(formData.actualWeight)
            : undefined,
        ratePerPound:
          formData.ratePerPound !== undefined
            ? parseFloat(formData.ratePerPound)
            : undefined,
        actualPrice:
          formData.actualPrice !== undefined
            ? parseFloat(formData.actualPrice)
            : undefined,
        ourPrice:
          formData.ourPrice !== undefined
            ? parseFloat(formData.ourPrice)
            : undefined,
        customerPrice:
          formData.customerPrice !== undefined
            ? parseFloat(formData.customerPrice)
            : undefined,
        negotiateTo: formData.negotiateTo || undefined,
        finalPrice:
          formData.finalPrice !== undefined
            ? parseFloat(formData.finalPrice)
            : undefined,
        priceDescription: formData.priceDescription || undefined,
        priceUploadedBy: req.user?._id,
      },

      kyc: {
        seller: sellerId,
        sellingDate: formData.sellingDate || undefined,
        pickupType: formData.pickupType || undefined,
        documents: formData.documents || {},
        sellerSignature: formData.sellerSignature || undefined,
        kycDescription: formData.kycDescription || undefined,
        kycUploadedBy: req.user?._id,
      },

      payment: {
        paymentMethod: formData.paymentMethod || undefined,
        paidAmount:
          formData.paidAmount !== undefined
            ? parseFloat(formData.paidAmount)
            : undefined,
        paymentDescription: formData.paymentDescription || undefined,
        paymentBy: req.user?._id,
      },
      seller: sellerId,
      createdBy: req.user._id,
    };

    // honor frontend-provided status if valid, otherwise compute
    try {
      const enumValues = CarIntake.schema.path("status").enumValues || [];
      if (formData.status && enumValues.includes(formData.status)) {
        carIntakeData.status = formData.status;
      } else {
        carIntakeData.status = computeStatusFrom(carIntakeData);
      }
    } catch (e) {
      carIntakeData.status = computeStatusFrom(carIntakeData);
    }

    carIntakeData.imagesStep.imagesUploadedBy = req.user?._id;

    // If a CarIntake with same VIN already exists, return it instead of creating duplicate
    if (carIntakeData.vin) {
      const existing = await CarIntake.findOne({
        vin: carIntakeData.vin,
      }).populate("createdBy", "first_name last_name email");
      if (existing) {
        return res.status(200).json({
          message: "Car intake already exists",
          carIntake: existing,
        });
      }
    }

    const carIntake = new CarIntake(carIntakeData);
    await carIntake.save();

    const populatedCarIntake = await CarIntake.findById(carIntake._id)
      .populate(
        "seller",
        "firstName lastName email mobileNo driversLicense description"
      )
      .populate("createdBy", "first_name last_name email");

    res.status(201).json({
      message: "Car intake created successfully",
      carIntake: populatedCarIntake,
    });
  } catch (error) {
    console.error("Create car intake error:", error);
    res.status(500).json({
      error: "Server error during car intake creation",
      details: error.message,
    });
  }
};

// @desc    Get all car intakes
// @route   GET /api/car-intake
// @access  Private
const getCarIntakes = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Build filter object
    const filter = { isActive: true, isDeleted: { $ne: true } };
    if (req.query.status) {
      // Support multiple status values. Accept formats:
      // - ?status=kyc-uploaded
      // - ?status=kyc-uploaded,payment-done
      // - ?status=kyc-uploaded&status=payment-done
      const raw = req.query.status;
      let statuses = [];
      if (Array.isArray(raw)) {
        statuses = raw
          .map((s) => String(s || ""))
          .flatMap((s) => s.split(","))
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        statuses = String(raw)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }

      if (statuses.length === 1) filter.status = statuses[0];
      else if (statuses.length > 1) filter.status = { $in: statuses };
    }
    if (req.query.make) {
      filter.make = new RegExp(req.query.make, "i");
    }
    if (req.query.year) {
      filter.year = req.query.year;
    }
    // Support free-text search across vin, make, model, trim and seller fields
    if (req.query.search) {
      const searchTerm = String(req.query.search).trim();
      if (searchTerm.length) {
        const re = new RegExp(
          searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "i"
        );

        // find sellers that match search (email/name/phone)
        let sellerIds = [];
        try {
          const sellers = await Seller.find({
            $or: [
              { email: re },
              { firstName: re },
              { lastName: re },
              { mobileNo: re },
            ],
          }).select("_id");
          sellerIds = (sellers || []).map((s) => s._id);
        } catch (e) {
          // ignore seller lookup errors and continue with other fields
          sellerIds = [];
        }

        const orArray = [
          { vin: re },
          { "carDetails.make": re },
          { "carDetails.model": re },
          { "carDetails.trim": re },
        ];
        if (sellerIds.length) orArray.push({ seller: { $in: sellerIds } });

        filter.$or = orArray;
      }
    }

    const carIntakes = await CarIntake.find(filter)
      .populate(
        "kyc.seller",
        "firstName lastName email mobileNo driversLicense description"
      )
      .populate("createdBy", "first_name last_name email")
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await CarIntake.countDocuments(filter);

    res.json({
      carIntakes,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Get car intakes error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Get single car intake
// @route   GET /api/car-intake/:id
// @access  Private
const getCarIntake = async (req, res) => {
  try {
    const carIntake = await CarIntake.findOne({
      _id: req.params.id,
      isDeleted: { $ne: true },
    })
      .populate(
        "kyc.seller",
        "firstName lastName email mobileNo signatureImage description"
      )
      .populate("createdBy", "first_name last_name email");

    if (!carIntake) {
      return res.status(404).json({ error: "Car intake not found" });
    }

    // Get related transaction
    const transaction = await Transaction.findOne({ carIntake: carIntake._id });

    res.json({
      carIntake,
      transaction,
    });
  } catch (error) {
    console.error("Get car intake error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Update car intake
// @route   PUT /api/car-intake/:id
// @access  Private
const updateCarIntake = async (req, res) => {
  try {
    const { sellerData, transactionData, ...carIntakeData } = req.body;

    const carIntake = await CarIntake.findById(req.params.id);
    if (!carIntake) {
      return res.status(404).json({ error: "Car intake not found" });
    }

    // Seller is now ObjectId from Customer
    let sellerId = carIntakeData.sellerId || carIntakeData.seller;

    // Validate sellerId if provided
    if (sellerId) {
      if (!/^[0-9a-fA-F]{24}$/.test(sellerId)) {
        return res
          .status(400)
          .json({ error: "Invalid seller ObjectId format" });
      }
      carIntake.seller = sellerId;
      carIntake.kyc = carIntake.kyc || {};
      carIntake.kyc.seller = sellerId;
    }

    // Update car intake: map flat incoming fields into nested model fields and set uploadedBy user
    // Car details
    const cdFields = [
      "year",
      "make",
      "model",
      "trim",
      "color",
      "bodyClass",
      "chassisNo",
      "engine",
      "engineVariant",
      "drive",
      "transmission",
      "scrapYardName",
      "scrapYardLocation",
      "fuelType",
      "keys",
      "weight",
      "dimensions",
      "description",
    ];
    let anyCd = false;
    cdFields.forEach((f) => {
      if (carIntakeData[f] !== undefined) {
        carIntake.carDetails = carIntake.carDetails || {};
        carIntake.carDetails[f] = carIntakeData[f];
        anyCd = true;
      }
    });
    if (anyCd) {
      carIntake.carDetails = carIntake.carDetails || {};
      carIntake.carDetails.carDetailsUploadedBy = req.user._id;
    }

    // Images
    if (carIntakeData.carImages) {
      carIntake.imagesStep = carIntake.imagesStep || {};
      const incomingImgs = carIntakeData.carImages || {};
      const keyMap = {
        carImage1: "image1",
        carImage2: "image2",
        carImage3: "image3",
        carImage4: "image4",
        carImage5: "image5",
        carImage6: "image6",
        carImage7: "image7",
        carImage8: "image8",
        carEngineImage: "engineImage",
        carBootImage: "bootImage",
        belowVehicleImage: "belowVehicleImage",
        fullVehicleImage: "fullVehicleImage",
        imageDescription: "imageDescription",
      };
      Object.keys(keyMap).forEach((inKey) => {
        if (incomingImgs[inKey] !== undefined) {
          carIntake.imagesStep[keyMap[inKey]] = normalizeImageValue(
            incomingImgs[inKey]
          );
        }
      });
      carIntake.imagesStep.imagesUploadedBy = req.user._id;
    }

    // Parts
    if (carIntakeData.parts) {
      carIntake.parts = Object.assign(
        carIntake.parts || {},
        carIntakeData.parts
      );
      carIntake.parts.partsUploadedBy = req.user._id;
    }

    // Ensure grouped `partDetails` is also kept in sync with incoming parts
    if (carIntakeData.parts || carIntakeData.partsDescription) {
      carIntake.partDetails = carIntake.partDetails || {};
      carIntake.partDetails.parts =
        carIntakeData.partDetails?.parts ||
        carIntakeData.parts ||
        carIntakeData.diagnosis ||
        carIntake.partDetails.parts ||
        {};
      carIntake.partDetails.partsDescription =
        carIntakeData.partDetails?.partsDescription ||
        carIntakeData.partsDescription ||
        carIntake.partDetails.partsDescription;
      carIntake.partDetails.partsUploadedBy = req.user._id;
    }

    // Price
    const priceFields = [
      "actualWeight",
      "ratePerPound",
      "actualPrice",
      "ourPrice",
      "customerPrice",
      "negotiateTo",
      "finalPrice",
      "priceDescription",
    ];
    let anyPrice = false;
    carIntake.price = carIntake.price || {};
    priceFields.forEach((f) => {
      if (carIntakeData[f] !== undefined) {
        carIntake.price[f] = carIntakeData[f];
        anyPrice = true;
      }
    });
    if (anyPrice) {
      carIntake.price = carIntake.price || {};
      carIntake.price.priceUploadedBy = req.user._id;
    }

    // KYC
    const kycFields = [
      "sellingDate",
      "pickupType",
      "documents",
      "sellerSignature",
      "kycDescription",
    ];
    let anyKyc = false;
    carIntake.kyc = carIntake.kyc || {};
    kycFields.forEach((f) => {
      if (carIntakeData[f] !== undefined) {
        if (f === "documents")
          carIntake.kyc.documents = carIntakeData.documents;
        else carIntake.kyc[f] = carIntakeData[f];
        anyKyc = true;
      }
    });
    if (anyKyc) {
      carIntake.kyc = carIntake.kyc || {};
      carIntake.kyc.kycUploadedBy = req.user._id;
    }

    // Payment
    const payFields = ["paymentMethod", "paidAmount", "paymentDescription"];
    let anyPay = false;
    carIntake.payment = carIntake.payment || {};
    payFields.forEach((f) => {
      if (carIntakeData[f] !== undefined) {
        if (f === "paidAmount")
          carIntake.payment.paidAmount = carIntakeData.paidAmount;
        else if (f === "paymentDescription")
          carIntake.payment.paymentDescription =
            carIntakeData.paymentDescription;
        else carIntake.payment.paymentMethod = carIntakeData.paymentMethod;
        anyPay = true;
      }
    });
    if (anyPay) {
      carIntake.payment = carIntake.payment || {};
      carIntake.payment.paymentBy = req.user._id;
    }

    // Merge any remaining allowed top-level
    const allowedTopLevel = [
      "vin",
      "vinDetails",
      "status",
      "isActive",
      "createdBy",
    ];
    Object.keys(carIntakeData).forEach((k) => {
      if (allowedTopLevel.includes(k)) {
        // If status provided from frontend, only accept if it's in enum
        if (k === "status") {
          try {
            const enumValues = CarIntake.schema.path("status").enumValues || [];
            if (enumValues.includes(carIntakeData.status))
              carIntake.status = carIntakeData.status;
          } catch (e) {
            // ignore
          }
        } else {
          carIntake[k] = carIntakeData[k];
        }
      }
    });

    // Recompute status based on new data and existing record, but do not
    // overwrite a valid status sent by the frontend in this update request.
    try {
      const enumValues = CarIntake.schema.path("status").enumValues || [];
      const merged = Object.assign({}, carIntake.toObject(), {});
      const computed = computeStatusFrom(merged);

      // If frontend provided a valid status in this payload, prefer it.
      if (carIntakeData.status && enumValues.includes(carIntakeData.status)) {
        carIntake.status = carIntakeData.status;
      } else {
        carIntake.status = computed;
      }
    } catch (e) {
      // ignore and keep existing status
    }

    await carIntake.save();

    // Determine incoming payment values from flat payload (if any)
    const incomingPaid =
      carIntakeData.paidAmount !== undefined
        ? carIntakeData.paidAmount
        : carIntakeData.payment && carIntakeData.payment.paidAmount;
    const incomingMethod =
      carIntakeData.paymentMethod !== undefined
        ? carIntakeData.paymentMethod
        : carIntakeData.payment && carIntakeData.payment.paymentMethod;
    const incomingDesc =
      carIntakeData.paymentDescription !== undefined
        ? carIntakeData.paymentDescription
        : carIntakeData.payment && carIntakeData.payment.paymentDescription;

    // Check if we have net amount and tax info from frontend
    const incomingNetAmount = carIntakeData.netAmount;
    const incomingTaxAmount = carIntakeData.taxAmount;
    const incomingTaxRate = carIntakeData.taxRate;

    // If payment details provided and transaction not exists, create one
    if (
      (transactionData ||
        incomingPaid !== undefined ||
        incomingMethod !== undefined) &&
      !(await Transaction.findOne({ carIntake: carIntake._id }))
    ) {
      // Use paidAmount (gross) if provided, otherwise use finalPrice (net)
      const transactionAmount =
        incomingPaid ?? carIntake.price?.finalPrice ?? 0;
      const isNet = incomingPaid === undefined; // if no paidAmount, finalPrice is net

      await new Transaction({
        type: "debit",
        amount: transactionAmount,
        amountIsNet: isNet,
        taxRate: incomingTaxRate ?? 0.06625,
        paymentMethod: incomingMethod ?? carIntake.payment?.paymentMethod,
        description: incomingDesc ?? carIntake.payment?.paymentDescription,
        carIntake: carIntake._id,
        seller: carIntake.seller,
        status: "completed",
        createdBy: req.user._id,
        ...transactionData,
      }).save();
    }

    // Update transaction if payment details changed
    if (
      transactionData ||
      incomingPaid !== undefined ||
      incomingMethod !== undefined ||
      incomingDesc !== undefined
    ) {
      const transactionAmount =
        incomingPaid ?? carIntake.price?.finalPrice ?? 0;
      const isNet = incomingPaid === undefined;

      await Transaction.findOneAndUpdate(
        { carIntake: carIntake._id },
        {
          amount: transactionAmount,
          amountIsNet: isNet,
          taxRate: incomingTaxRate ?? 0.06625,
          paymentMethod: incomingMethod ?? carIntake.payment?.paymentMethod,
          description: incomingDesc ?? carIntake.payment?.paymentDescription,
          ...transactionData,
        }
      );
    }

    const updatedCarIntake = await CarIntake.findById(carIntake._id)
      .populate(
        "seller",
        "firstName lastName email mobileNo driversLicense description"
      )
      .populate("createdBy", "first_name last_name email");

    res.json({
      message: "Car intake updated successfully",
      carIntake: updatedCarIntake,
    });
  } catch (error) {
    console.error("Update car intake error:", error);
    res.status(500).json({
      error: "Server error during update",
      details: error.message,
    });
  }
};

// @desc    Delete car intake
// @route   DELETE /api/car-intake/:id
// @access  Private
const deleteCarIntake = async (req, res) => {
  try {
    const carIntake = await CarIntake.findById(req.params.id);
    if (!carIntake) {
      return res.status(404).json({ error: "Car intake not found" });
    }

    // Soft delete - set isActive to false and mark deleted
    carIntake.isActive = false;
    carIntake.isDeleted = true;
    carIntake.deletedAt = new Date();
    await carIntake.save();

    // Also soft delete related transaction(s)
    await Transaction.updateMany(
      { carIntake: carIntake._id },
      { isActive: false, isDeleted: true, deletedAt: new Date() }
    );

    res.json({ message: "Car intake deleted successfully" });
  } catch (error) {
    console.error("Delete car intake error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Update car intake status
// @route   PATCH /api/car-intake/:id/status
// @access  Private
const updateCarIntakeStatus = async (req, res) => {
  try {
    const { status } = req.body;

    // validate against model enum values
    const enumValues = CarIntake.schema.path("status").enumValues || [];
    if (!enumValues.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    // If status is 'scraped', also set scrapedBy to current user
    const update = { status };
    if (status === "scraped") {
      update.scrapedBy = req.user?._id;
      update.scrapDate = new Date();
    }

    const carIntake = await CarIntake.findByIdAndUpdate(req.params.id, update, {
      new: true,
    })
      .populate(
        "kyc.seller",
        "firstName lastName email mobileNo driversLicense description"
      )
      .populate("scrapedBy", "first_name last_name email");

    if (!carIntake) {
      return res.status(404).json({ error: "Car intake not found" });
    }

    res.json({
      message: "Status updated successfully",
      carIntake,
    });
  } catch (error) {
    console.error("Update status error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Get car intake statistics
// @route   GET /api/car-intake/stats
// @access  Private
const getCarIntakeStats = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const matchStage = { isActive: true };
    if (startDate || endDate) {
      matchStage.createdAt = {};
      if (startDate) matchStage.createdAt.$gte = new Date(startDate);
      if (endDate) matchStage.createdAt.$lte = new Date(endDate);
    }

    const stats = await CarIntake.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalValue: { $sum: "$finalPrice" },
          averageValue: { $avg: "$finalPrice" },
        },
      },
    ]);

    const totalCount = await CarIntake.countDocuments(matchStage);
    const totalValue = await CarIntake.aggregate([
      { $match: matchStage },
      { $group: { _id: null, total: { $sum: "$finalPrice" } } },
    ]);

    res.json({
      stats,
      summary: {
        totalCount,
        totalValue: totalValue[0]?.total || 0,
      },
    });
  } catch (error) {
    console.error("Get stats error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Render payment slip for a car intake
// @route   GET /api/car-intake/:id/print-payment
// @access  Private
const printPaymentSlip = async (req, res) => {
  try {
    const id = req.params.id;
    const carIntake = await CarIntake.findOne({
      _id: id,
      isDeleted: { $ne: true },
    })
      .populate(
        "kyc.seller",
        "firstName lastName email mobileNo signatureImage description"
      )
      .populate("createdBy", "first_name last_name email");

    if (!carIntake) return res.status(404).send("Car intake not found");

    // Find latest active transaction for this car intake
    const transaction = await Transaction.findOne({
      carIntake: carIntake._id,
      isActive: true,
    })
      .sort({ createdAt: -1 })
      .populate("createdBy", "first_name last_name email");

    // Try to find an existing PaymentSlip for this car intake (prefer most recent)
    let paymentSlipDoc = null;
    try {
      const PaymentSlipModel = require("../models/PaymentSlip");
      paymentSlipDoc = await PaymentSlipModel.findOne({
        carIntake: carIntake._id,
      })
        .sort({ createdAt: -1 })
        .populate("transaction")
        .populate("createdBy", "first_name last_name email");

      // If no slip exists, create one now using current carIntake + transaction data
      if (!paymentSlipDoc) {
        const PaymentSlipModelInst = PaymentSlipModel;

        // Build slip snapshot data
        // finalPrice is what the seller receives (net amount)
        const finalPrice = carIntake.price?.finalPrice || 0;
        const netAmount = finalPrice;
        const taxRate =
          (transaction && transaction.taxRate) || carIntake.taxRate || 0.06625;

        // Calculate gross from net: gross = net / (1 - tax_rate)
        const grossAmount = netAmount / (1 - taxRate);
        const taxAmount = grossAmount - netAmount;

        const slipData = {
          amount: grossAmount,
          netAmount: netAmount,
          taxRate,
          taxAmount,
          paymentMethod:
            (transaction && transaction.paymentMethod) ||
            carIntake.payment?.paymentMethod,
          paymentDescription:
            (transaction && transaction.description) ||
            carIntake.payment?.paymentDescription,
          carSnapshot: carIntake.toObject(),
          transactionSnapshot: transaction ? transaction.toObject() : null,
        };

        const created = await PaymentSlipModelInst.create({
          carIntake: carIntake._id,
          transaction: transaction?._id,
          slipData,
          // store explicit snapshot fields so queries can read them directly
          paymentMethod: slipData.paymentMethod,
          grossAmount: Math.round((grossAmount + Number.EPSILON) * 100) / 100,
          netAmount: Math.round((netAmount + Number.EPSILON) * 100) / 100,
          taxRate: slipData.taxRate,
          taxAmount: Math.round((taxAmount + Number.EPSILON) * 100) / 100,
          paymentDate: transaction?.createdAt || new Date(),
          createdBy: req.user?._id,
        });

        // re-fetch populated doc
        paymentSlipDoc = await PaymentSlipModelInst.findById(created._id)
          .populate("transaction")
          .populate("createdBy", "first_name last_name email");
      }
    } catch (e) {
      // PaymentSlip model not available or population failed - ignore
      console.warn("PaymentSlip creation/check failed:", e && e.message);
      paymentSlipDoc = null;
    }

    // Load logo as base64 data URI so templates / PDF renderers always have the image
    let logoDataUri = null;
    try {
      const logoPath = path.join(__dirname, "..", "assets", "logo-sm1.png");
      if (fs.existsSync(logoPath)) {
        const buf = fs.readFileSync(logoPath);
        const b64 = buf.toString("base64");
        logoDataUri = `data:image/png;base64,${b64}`;
      }
    } catch (e) {
      // ignore logo read errors
      console.warn("Could not read logo for payment slip:", e && e.message);
      logoDataUri = null;
    }

    // compute padded slip string if paymentSlip found
    const slipPadded =
      paymentSlipDoc && paymentSlipDoc.slipNumber
        ? String(paymentSlipDoc.slipNumber).padStart(7, "0")
        : null;

    const data = {
      carIntake,
      transaction,
      paymentSlip: paymentSlipDoc,
      slipPadded,
      generatedAt: new Date(),
      generatedBy: req.user
        ? { id: req.user._id, name: req.user.first_name || req.user.name || "" }
        : null,
      // Prefer inline base64 logo when available; otherwise template will fall back to /assets/logo-sm1.png
      logoSrc: logoDataUri || "/assets/logo-sm1.png",
    };

    // If client requests PDF or raw HTML, we can extend later. For now render HTML
    return res.render("paymentSlip.njk", data);
  } catch (err) {
    console.error("Print payment slip error:", err);
    return res
      .status(500)
      .json({ error: "Server error rendering payment slip" });
  }
};

// @desc    Print combined documents (receipt + title certificate)
// @route   GET /api/car-intake/:id/print-all-documents
// @access  Private
const printAllDocuments = async (req, res) => {
  try {
    const id = req.params.id;
    const carIntake = await CarIntake.findOne({
      _id: id,
      isDeleted: { $ne: true },
    })
      .populate(
        "kyc.seller",
        "firstName lastName email mobileNo signatureImage description"
      )
      .populate("createdBy", "first_name last_name email");

    if (!carIntake) return res.status(404).send("Car intake not found");

    // Find latest active transaction for this car intake
    const transaction = await Transaction.findOne({
      carIntake: carIntake._id,
      isActive: true,
    })
      .sort({ createdAt: -1 })
      .populate("createdBy", "first_name last_name email");

    // Try to find an existing PaymentSlip for this car intake (prefer most recent)
    let paymentSlipDoc = null;
    try {
      const PaymentSlipModel = require("../models/PaymentSlip");
      paymentSlipDoc = await PaymentSlipModel.findOne({
        carIntake: carIntake._id,
      })
        .sort({ createdAt: -1 })
        .populate("transaction")
        .populate("createdBy", "first_name last_name email");

      // If no slip exists, create one now using current carIntake + transaction data
      if (!paymentSlipDoc) {
        const PaymentSlipModelInst = PaymentSlipModel;

        // Build slip snapshot data
        // finalPrice is what the seller receives (net amount)
        const finalPrice = carIntake.price?.finalPrice || 0;
        const netAmount = finalPrice;
        const taxRate =
          (transaction && transaction.taxRate) || carIntake.taxRate || 0.06625;

        // Calculate gross from net: gross = net / (1 - tax_rate)
        const grossAmount = netAmount / (1 - taxRate);
        const taxAmount = grossAmount - netAmount;

        const slipData = {
          amount: grossAmount,
          netAmount: netAmount,
          taxRate,
          taxAmount,
          paymentMethod:
            (transaction && transaction.paymentMethod) ||
            carIntake.payment?.paymentMethod,
          paymentDescription:
            (transaction && transaction.description) ||
            carIntake.payment?.paymentDescription,
          carSnapshot: carIntake.toObject(),
          transactionSnapshot: transaction ? transaction.toObject() : null,
        };

        const created = await PaymentSlipModelInst.create({
          carIntake: carIntake._id,
          transaction: transaction?._id,
          slipData,
          // store explicit snapshot fields so queries can read them directly
          paymentMethod: slipData.paymentMethod,
          grossAmount: Math.round((grossAmount + Number.EPSILON) * 100) / 100,
          netAmount: Math.round((netAmount + Number.EPSILON) * 100) / 100,
          taxRate: slipData.taxRate,
          taxAmount: Math.round((taxAmount + Number.EPSILON) * 100) / 100,
          paymentDate: transaction?.createdAt || new Date(),
          createdBy: req.user?._id,
        });

        // re-fetch populated doc
        paymentSlipDoc = await PaymentSlipModelInst.findById(created._id)
          .populate("transaction")
          .populate("createdBy", "first_name last_name email");
      }
    } catch (e) {
      // PaymentSlip model not available or population failed - ignore
      console.warn("PaymentSlip creation/check failed:", e && e.message);
      paymentSlipDoc = null;
    }

    // Load logo as base64 data URI so templates / PDF renderers always have the image
    let logoDataUri = null;
    try {
      const logoPath = path.join(__dirname, "..", "assets", "logo-sm1.png");
      if (fs.existsSync(logoPath)) {
        const buf = fs.readFileSync(logoPath);
        const b64 = buf.toString("base64");
        logoDataUri = `data:image/png;base64,${b64}`;
      }
    } catch (e) {
      // ignore logo read errors
      console.warn("Could not read logo for payment slip:", e && e.message);
      logoDataUri = null;
    }

    // Handle title certificate - silently skip if missing
    let titleCertificateDataUri = null;
    try {
      const titleCertPath = carIntake?.kyc?.documents?.titleCertificate;
      if (titleCertPath) {
        // Extract filename from path (could be /uploads/filename.jpg or just filename.jpg)
        let filename = titleCertPath;
        if (filename.startsWith("/uploads/")) {
          filename = filename.replace("/uploads/", "");
        } else if (filename.startsWith("uploads/")) {
          filename = filename.replace("uploads/", "");
        }

        const filePath = path.join(__dirname, "..", "uploads", filename);
        
        // Check if file exists before attempting to read
        if (fs.existsSync(filePath)) {
          const buf = fs.readFileSync(filePath);
          const ext = path.extname(filename).toLowerCase();
          
          // Determine MIME type based on extension
          const mimeTypes = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".gif": "image/gif",
            ".webp": "image/webp",
          };
          
          const mimeType = mimeTypes[ext] || "image/jpeg";
          const b64 = buf.toString("base64");
          titleCertificateDataUri = `data:${mimeType};base64,${b64}`;
        } else {
          // File not found - silently continue without title certificate
          console.warn(
            `Title certificate file not found: ${filePath} for car intake ${id}`
          );
        }
      }
    } catch (e) {
      // Silently handle any errors reading title certificate - just log for debugging
      console.warn(
        "Could not read title certificate for combined print:",
        e && e.message
      );
      titleCertificateDataUri = null;
    }

    // compute padded slip string if paymentSlip found
    const slipPadded =
      paymentSlipDoc && paymentSlipDoc.slipNumber
        ? String(paymentSlipDoc.slipNumber).padStart(7, "0")
        : null;

    const data = {
      carIntake,
      transaction,
      paymentSlip: paymentSlipDoc,
      slipPadded,
      generatedAt: new Date(),
      generatedBy: req.user
        ? { id: req.user._id, name: req.user.first_name || req.user.name || "" }
        : null,
      // Prefer inline base64 logo when available; otherwise template will fall back to /assets/logo-sm1.png
      logoSrc: logoDataUri || "/assets/logo-sm1.png",
      titleCertificateDataUri, // Will be null if not available
    };

    // Render combined template
    return res.render("combinedDocuments.njk", data);
  } catch (err) {
    console.error("Print all documents error:", err);
    return res
      .status(500)
      .json({ error: "Server error rendering documents" });
  }
};

// @desc    Bulk upload car intakes from Excel
// @route   POST /api/car-intake/bulk-upload
// @access  Private
const bulkUploadCarIntakes = async (req, res) => {
  try {
    const { fileUrl } = req.body;

    if (!fileUrl) {
      return res.status(400).json({ error: "No file URL provided" });
    }

    // Extract filename from URL (e.g., "/uploads/filename.xlsx" -> "filename.xlsx")
    const filename = fileUrl.replace(/^\/uploads\//, "");

    // Construct file path
    const filePath = path.join(__dirname, "../uploads", filename);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }

    // Read the Excel file
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet);

    if (!data || data.length === 0) {
      return res.status(400).json({ error: "Excel file is empty" });
    }

    const results = {
      successful: [],
      failed: [],
      skipped: [],
    };

    // Collect all VINs from the Excel file
    const vinsToCheck = data
      .map((row, i) => {
        const vin = row.vin || row.VIN;
        return vin ? vin.toString().trim().toUpperCase() : null;
      })
      .filter(Boolean);

    // Check for existing VINs in bulk
    const existingVins = await CarIntake.find({
      vin: { $in: vinsToCheck },
    })
      .select("vin")
      .lean();

    const existingVinSet = new Set(existingVins.map((v) => v.vin));

    // Array to hold valid car intakes for bulk insert
    const carIntakesToInsert = [];

    // Process each row
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowNumber = i + 2; // +2 because Excel rows start at 1 and first row is header

      try {
        // Extract and normalize data from row
        const make = row.Make || row.make;
        const model = row.Modal || row.Model || row.model;
        const year = row.Year || row.year;
        const trim = row.trim || row.Trim;
        const vin = row.vin || row.VIN;
        const color = row.color || row.Color;
        const bodyClass =
          row["Boday Class"] || row["Body Class"] || row.bodyClass;
        const engine = row.Engine || row.engine;
        const transmission = row.Transmission || row.transmission;
        const drive = row.Drive || row.drive;
        const fuelType = row["Fuel type"] || row["Fuel Type"] || row.fuelType;
        const where = row.Where || row.where || row.Location;
        const keys = row.Keys || row.keys;
        const dateIn = row["date In"] || row["Date In"] || row.dateIn;

        // Validate required fields - only VIN is required
        if (!vin) {
          results.skipped.push({
            row: rowNumber,
            reason: "Missing required field: VIN",
            data: row,
          });
          continue;
        }

        const normalizedVin = vin.toString().trim().toUpperCase();

        // Check if VIN already exists
        if (existingVinSet.has(normalizedVin)) {
          results.skipped.push({
            row: rowNumber,
            reason: "VIN already exists",
            vin: normalizedVin,
          });
          continue;
        }

        // Parse keys field (accept various formats)
        let hasKeys = undefined;
        if (keys !== undefined && keys !== null && keys !== "") {
          const keysStr = keys.toString().trim().toLowerCase();
          hasKeys =
            keysStr === "yes" ||
            keysStr === "true" ||
            keysStr === "1" ||
            keysStr === "on";
        }

        // Parse drive field and validate
        let parsedDrive = undefined;
        if (drive) {
          const driveStr = drive.toString().trim().toUpperCase();
          const validDriveValues = ["2WD", "4WD", "AWD", "FWD"];
          if (validDriveValues.includes(driveStr)) {
            parsedDrive = driveStr;
          }
        }

        // Parse transmission and validate
        let parsedTransmission = undefined;
        if (transmission) {
          const transStr = transmission.toString().trim();
          const validTransmissionValues = ["Automatic", "Manual"];
          const matchedTrans = validTransmissionValues.find(
            (v) => v.toLowerCase() === transStr.toLowerCase()
          );
          if (matchedTrans) {
            parsedTransmission = matchedTrans;
          }
        }

        // Parse dateIn and use it as createdAt if provided
        let createdAtDate = undefined;
        if (dateIn) {
          try {
            // Handle Excel date serial numbers
            if (typeof dateIn === "number") {
              // Excel stores dates as days since 1900-01-01
              const excelEpoch = new Date(1899, 11, 30);
              createdAtDate = new Date(
                excelEpoch.getTime() + dateIn * 86400000
              );
            } else {
              createdAtDate = new Date(dateIn);
            }

            // Validate the date
            if (isNaN(createdAtDate.getTime())) {
              createdAtDate = undefined;
            }
          } catch (err) {
            createdAtDate = undefined;
          }
        }

        // Prepare car intake data
        const carIntakeData = {
          vin: normalizedVin,
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
            carDetailsUploadedBy: req.user._id,
          },
          status: "intake",
          createdBy: req.user._id,
        };

        // Add custom createdAt if dateIn was provided and valid
        if (createdAtDate) {
          carIntakeData.createdAt = createdAtDate;
          carIntakeData.updatedAt = createdAtDate;
        }

        // Add to bulk insert array with row number for reference
        carIntakesToInsert.push({
          data: carIntakeData,
          row: rowNumber,
        });
      } catch (error) {
        console.error(`Error processing row ${rowNumber}:`, error);
        results.failed.push({
          row: rowNumber,
          reason: error.message,
          data: row,
        });
      }
    }

    // Perform bulk insert
    if (carIntakesToInsert.length > 0) {
      try {
        const insertedDocs = await CarIntake.insertMany(
          carIntakesToInsert.map((item) => item.data),
          { ordered: false } // Continue inserting even if some fail
        );

        // Map inserted documents to their row numbers
        insertedDocs.forEach((doc, index) => {
          const item = carIntakesToInsert[index];
          const cd = doc.carDetails || {};
          const carDesc =
            [cd.year, cd.make, cd.model].filter(Boolean).join(" ") || "Car";
          results.successful.push({
            row: item.row,
            vin: doc.vin,
            car: carDesc,
            id: doc._id,
          });
        });
      } catch (error) {
        // Handle bulk insert errors
        if (error.name === "MongoBulkWriteError" && error.writeErrors) {
          // Some documents succeeded, some failed
          error.insertedDocs?.forEach((doc, index) => {
            if (doc && doc._id) {
              const item = carIntakesToInsert[index];
              const cd = doc.carDetails || {};
              const carDesc =
                [cd.year, cd.make, cd.model].filter(Boolean).join(" ") || "Car";
              results.successful.push({
                row: item.row,
                vin: doc.vin,
                car: carDesc,
                id: doc._id,
              });
            }
          });

          // Track failed insertions
          error.writeErrors.forEach((writeError) => {
            const item = carIntakesToInsert[writeError.index];
            results.failed.push({
              row: item.row,
              reason:
                writeError.errmsg ||
                writeError.err?.message ||
                "Database insertion failed",
              data: item.data,
            });
          });
        } else {
          // Complete failure
          console.error("Bulk insert error:", error);
          carIntakesToInsert.forEach((item) => {
            results.failed.push({
              row: item.row,
              reason: error.message || "Database insertion failed",
              data: item.data,
            });
          });
        }
      }
    }

    res.status(200).json({
      message: "Bulk upload completed",
      summary: {
        total: data.length,
        successful: results.successful.length,
        failed: results.failed.length,
        skipped: results.skipped.length,
      },
      results,
    });
  } catch (error) {
    console.error("Bulk upload error:", error);

    res.status(500).json({
      error: "Server error during bulk upload",
      details: error.message,
    });
  }
};

// @desc    Bulk upload scraped car records from Excel (sheet named 'GONE')
// @route   POST /api/car-intake/bulk-upload-scraped
// @access  Private
const bulkUploadScraped = async (req, res) => {
  try {
    const { fileUrl } = req.body;

    if (!fileUrl) {
      return res.status(400).json({ error: "No file URL provided" });
    }

    const filename = fileUrl.replace(/^\/uploads\//, "");
    const filePath = path.join(__dirname, "../uploads", filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }

    const workbook = xlsx.readFile(filePath);

    // Find sheet named GONE (case-insensitive)
    const sheetName = workbook.SheetNames.find(
      (n) => String(n || "").toLowerCase() === "gone"
    );

    if (!sheetName) {
      return res.status(400).json({ error: "Sheet 'GONE' not found" });
    }

    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet, { raw: true });

    if (!data || data.length === 0) {
      return res.status(400).json({ error: "GONE sheet is empty" });
    }

    const results = { successful: [], failed: [], skipped: [] };

    // We'll collect vins to avoid duplicates in import
    const vinsToCheck = data
      .map((row) => {
        const vin = row.vin || row.VIN || row.VIN_NUMBER || row["VIN"];
        return vin ? String(vin).trim().toUpperCase() : null;
      })
      .filter(Boolean);

    const existing = await CarIntake.find({ vin: { $in: vinsToCheck } })
      .select("vin")
      .lean();
    const existingSet = new Set(existing.map((d) => d.vin));

    const toInsert = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowNumber = i + 2;
      try {
        // Determine status from 'What Happen?' / variants. Support 'crushed', 'sold', 'towed'.
        const what =
          row["What Happen?"] ||
          row["What Happend?"] ||
          row["What Happened?"] ||
          row.what ||
          row.what_happen ||
          row.what_happend ||
          row.what_happened;

        let statusForRow = null;
        const whatMissing =
          what === undefined || what === null || String(what).trim() === "";

        if (whatMissing) {
          // If 'What' not provided, save as intake and apply default yard values later
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
            // Unhandled 'what' value; skip row
            results.skipped.push({
              row: rowNumber,
              reason: "Unhandled 'What Happen?' value",
            });
            continue;
          }
        }

        // VIN required
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

        // Date in maps to createdAt
        let createdAt = undefined;
        const dateIn =
          row["Date in"] ||
          row["date In"] ||
          row["Date In"] ||
          row.dateIn ||
          row["Date In "] ||
          row["DateIn"];
        if (dateIn) {
          if (typeof dateIn === "number") {
            const excelEpoch = new Date(1899, 11, 30);
            createdAt = new Date(excelEpoch.getTime() + dateIn * 86400000);
          } else {
            const dt = new Date(dateIn);
            if (!isNaN(dt.getTime())) createdAt = dt;
          }
        }

        // Date maps to scrapDate
        let scrapDate = undefined;
        const dateField =
          row.Date || row.date || row["Date "] || row["Scrap Date"];
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
          carDetailsUploadedBy: req.user?._id,
        };

        // Apply defaults for missing 'what'
        if (statusForRow === "intake") {
          carDetails.scrapYardName =
            row["Scrap Yard"] || row.scrapYardName || "RTX";
          carDetails.scrapYardLocation =
            row["Scrap Yard Location"] || row.scrapYardLocation || "New Jersey";
        } else {
          // If sheet provided explicit yard info, map it; otherwise leave undefined
          if (row["Scrap Yard"] || row.scrapYardName)
            carDetails.scrapYardName = row["Scrap Yard"] || row.scrapYardName;
          if (row["Scrap Yard Location"] || row.scrapYardLocation)
            carDetails.scrapYardLocation =
              row["Scrap Yard Location"] || row.scrapYardLocation;
        }

        const generatedAt = new Date();
        const generatedAtStr = generatedAt.toLocaleString();
        const transactionDateStr =
          transaction && transaction.transactionDate
            ? transaction.transactionDate.toLocaleString()
            : null;

        const data = {
          carIntake,
          transaction,
          generatedAtStr,
          transactionDateStr,
          generatedBy: req.user
            ? {
                id: req.user._id,
                name: req.user.first_name || req.user.name || "",
              }
            : null,
        };

        // Render HTML using Nunjucks template
        return res.render("paymentSlip.njk", data);
        if (statusForRow === "scraped") {
          doc.scrapedBy = req.user?._id;
        }

        if (createdAt) {
          doc.createdAt = createdAt;
          doc.updatedAt = createdAt;
        }

        toInsert.push({ data: doc, row: rowNumber });
      } catch (err) {
        console.error(`Error processing GONE row ${rowNumber}:`, err);
        results.failed.push({ row: rowNumber, reason: err.message });
      }
    }

    if (toInsert.length > 0) {
      try {
        const inserted = await CarIntake.insertMany(
          toInsert.map((t) => t.data),
          { ordered: false }
        );

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
            results.failed.push({
              row: item.row,
              reason: we.errmsg || we.err?.message,
            });
          });
        } else {
          console.error("Bulk insert GONE error:", err);
          toInsert.forEach((it) =>
            results.failed.push({ row: it.row, reason: err.message })
          );
        }
      }
    }

    res.status(200).json({
      message: "Bulk scraped upload completed",
      summary: {
        total: data.length,
        successful: results.successful.length,
        failed: results.failed.length,
        skipped: results.skipped.length,
      },
      results,
    });
  } catch (error) {
    console.error("Bulk upload scraped error:", error);
    res.status(500).json({
      error: "Server error during bulk upload scraped",
      details: error.message,
    });
  }
};

module.exports = {
  createCarIntake,
  getCarIntakes,
  getCarIntake,
  updateCarIntake,
  deleteCarIntake,
  updateCarIntakeStatus,
  getCarIntakeStats,
  bulkUploadCarIntakes,
  bulkUploadScraped,
  printPaymentSlip,
  printAllDocuments,
};
