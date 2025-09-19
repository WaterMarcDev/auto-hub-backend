const CarIntake = require("../models/carInTake.model");
const Seller = require("../models/Seller");
const Transaction = require("../models/Transaction");

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

    // Extract and parse form data
    const formData = req.body;

    // Map KYC data to seller data (expect nested JSON `sellerData`)
    let sellerData = {
      firstName: "",
      lastName: "",
      email: "",
      mobileNo: "",
      description: "",
      driversLicense: "",
    };

    if (formData.sellerData && typeof formData.sellerData === "object") {
      sellerData = {
        firstName: formData.sellerData.firstName || "",
        lastName: formData.sellerData.lastName || "",
        email: formData.sellerData.email || "",
        mobileNo: formData.sellerData.mobileNo || "",
        description:
          formData.sellerData.description || formData.kycDescription || "",
        driversLicense:
          formData.documents.driversLicense || formData.driversLicense || "",
      };
    }

    console.log("Mapped seller data:", sellerData);

    // If sellerData provided, validate required fields; otherwise allow draft creation
    const hasSellerPayload = !!(
      formData.sellerData ||
      formData.firstName ||
      formData.lastName ||
      formData.mobileNo ||
      formData.email
    );

    if (hasSellerPayload) {
      if (
        !sellerData.firstName ||
        !sellerData.lastName ||
        !sellerData.email ||
        !sellerData.mobileNo
      ) {
        return res.status(400).json({
          error: "Missing required seller data",
          details: {
            firstName: sellerData.firstName || "missing",
            lastName: sellerData.lastName || "missing",
            email: sellerData.email || "missing",
            mobileNo: sellerData.mobileNo || "missing",
          },
        });
      }
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
        engineNo: formData.engineNo || undefined,
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
        // Map known frontend keys to schema image keys
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
      // mark who uploaded images
      // We'll set imagesUploadedBy after creating the seller

      parts: Object.assign({}, formData.parts || formData.diagnosis || {}, {
        partsUploadedBy: req.user?._id,
      }),

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
        // seller set after creating Seller
        sellingDate: formData.sellingDate || undefined,
        pickupType: formData.pickupType || undefined,
        documents: formData.documents || {},
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
    };

    // Transaction data
    const transactionData = {
      description:
        formData.paymentDescription ||
        `Payment for ${carIntakeData.year} ${carIntakeData.make} ${carIntakeData.model}`,
    };

    // Start creating records (without MongoDB transactions for single node setup)
    try {
      // If we have seller payload, create Seller + CarIntake + Transaction (full flow)
      if (hasSellerPayload) {
        const seller = new Seller({
          ...sellerData,
          createdBy: req.user._id,
        });
        await seller.save();

        // After creating seller, set kyc.seller and images uploadedBy
        carIntakeData.kyc.seller = seller._id;
        carIntakeData.imagesStep.imagesUploadedBy = req.user?._id;

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

        const carIntake = new CarIntake({
          ...carIntakeData,
          seller: seller._id,
          createdBy: req.user._id,
        });
        await carIntake.save();

        // Create Transaction with references to both if payment info present
        let transaction = null;
        if (hasPaymentIn(carIntake)) {
          transaction = new Transaction({
            type: "credit",
            amount: carIntake.price?.finalPrice || carIntake.finalPrice || 0,
            paymentMethod:
              carIntake.payment?.paymentMethod || carIntake.paymentMethod,
            description:
              carIntake.payment?.paymentDescription ||
              `Payment for ${carIntake.carDetails?.year || ""} ${
                carIntake.carDetails?.make || ""
              } ${carIntake.carDetails?.model || ""}`,
            carIntake: carIntake._id,
            seller: seller._id,
            status: "completed",
            createdBy: req.user._id,
            ...transactionData,
          });
          await transaction.save();
        }

        // Populate references for response
        const populatedCarIntake = await CarIntake.findById(carIntake._id)
          .populate("seller", "firstName lastName email mobileNo")
          .populate("createdBy", "first_name last_name email");

        res.status(201).json({
          message: "Car intake created successfully",
          carIntake: populatedCarIntake,
          seller: seller,
          transaction: transaction,
        });
      } else {
        // No seller payload: create or return existing draft CarIntake (no Seller/Transaction yet)
        carIntakeData.imagesStep.imagesUploadedBy = req.user?._id;

        // If a CarIntake with same VIN already exists, return it instead of creating duplicate
        if (carIntakeData.vin) {
          const existing = await CarIntake.findOne({
            vin: carIntakeData.vin,
          }).populate("createdBy", "first_name last_name email");
          if (existing) {
            return res.status(200).json({
              message: "Draft car intake already exists",
              carIntake: existing,
            });
          }
        }

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

        const carIntake = new CarIntake({
          ...carIntakeData,
          createdBy: req.user._id,
        });
        await carIntake.save();

        const populatedCarIntake = await CarIntake.findById(
          carIntake._id
        ).populate("createdBy", "first_name last_name email");

        res.status(201).json({
          message: "Draft car intake created",
          carIntake: populatedCarIntake,
        });
      }
    } catch (error) {
      // Handle errors without transaction rollback
      console.error("Error creating car intake:", error);
      throw error;
    }
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
    const filter = { isActive: true };
    if (req.query.status) {
      filter.status = req.query.status;
    }
    if (req.query.make) {
      filter.make = new RegExp(req.query.make, "i");
    }
    if (req.query.year) {
      filter.year = req.query.year;
    }

    const carIntakes = await CarIntake.find(filter)
      .populate("seller", "firstName lastName email mobileNo")
      .populate("createdBy", "first_name last_name email")
      .sort({ createdAt: -1 })
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
    const carIntake = await CarIntake.findById(req.params.id)
      .populate(
        "seller",
        "firstName lastName email mobileNo driversLicense description"
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

    // Update without transactions for single node setup
    try {
      // Update seller if seller data provided
      if (sellerData) {
        if (carIntake.seller) {
          await Seller.findByIdAndUpdate(carIntake.seller, {
            ...sellerData,
            updatedBy: req.user._id,
          });
        } else {
          // create seller and attach to carIntake
          const newSeller = new Seller({
            ...sellerData,
            createdBy: req.user._id,
          });
          await newSeller.save();
          carIntake.seller = newSeller._id;
          carIntake.kyc = carIntake.kyc || {};
          carIntake.kyc.seller = newSeller._id;
        }
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
        "engineNo",
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
              const enumValues =
                CarIntake.schema.path("status").enumValues || [];
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
          console.log(
            `CarIntake ${carIntake._id} status set from frontend: ${carIntake.status}`
          );
        } else {
          carIntake.status = computed;
          console.log(
            `CarIntake ${carIntake._id} status computed: ${carIntake.status}`
          );
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

      // If payment details provided and transaction not exists, create one
      if (
        (transactionData ||
          incomingPaid !== undefined ||
          incomingMethod !== undefined) &&
        !(await Transaction.findOne({ carIntake: carIntake._id }))
      ) {
        await new Transaction({
          type: "credit",
          amount:
            incomingPaid ??
            carIntake.payment?.paidAmount ??
            carIntake.price?.finalPrice ??
            0,
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
        await Transaction.findOneAndUpdate(
          { carIntake: carIntake._id },
          {
            amount:
              incomingPaid ??
              carIntake.payment?.paidAmount ??
              carIntake.price?.finalPrice ??
              0,
            paymentMethod: incomingMethod ?? carIntake.payment?.paymentMethod,
            description: incomingDesc ?? carIntake.payment?.paymentDescription,
            ...transactionData,
          }
        );
      }

      const updatedCarIntake = await CarIntake.findById(carIntake._id)
        .populate("seller", "firstName lastName email mobileNo")
        .populate("createdBy", "first_name last_name email");

      res.json({
        message: "Car intake updated successfully",
        carIntake: updatedCarIntake,
      });
    } catch (error) {
      console.error("Error updating car intake:", error);
      throw error;
    }
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

    // Soft delete - set isActive to false
    carIntake.isActive = false;
    await carIntake.save();

    // Also soft delete related transaction
    await Transaction.findOneAndUpdate(
      { carIntake: carIntake._id },
      { isActive: false }
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

    const carIntake = await CarIntake.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    ).populate("seller", "firstName lastName email mobileNo");

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

module.exports = {
  createCarIntake,
  getCarIntakes,
  getCarIntake,
  updateCarIntake,
  deleteCarIntake,
  updateCarIntakeStatus,
  getCarIntakeStats,
};
