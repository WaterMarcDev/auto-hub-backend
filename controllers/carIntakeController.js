const CarIntake = require("../models/CarIntake");
const Seller = require("../models/Seller");
const Transaction = require("../models/Transaction");

// @desc    Create new car intake (with seller and transaction)
// @route   POST /api/car-intake
// @access  Private
const createCarIntake = async (req, res) => {
  try {
    console.log("Received car intake data:", req.body);
    console.log("Received files:", req.files);
    console.log("Form data keys:", Object.keys(req.body));
    console.log("Seller fields:", {
      "sellerData.firstName": req.body["sellerData.firstName"],
      "sellerData.lastName": req.body["sellerData.lastName"],
      "sellerData.email": req.body["sellerData.email"],
      "sellerData.mobileNo": req.body["sellerData.mobileNo"],
    });

    // Extract and parse form data
    const formData = req.body;

    // Map KYC data to seller data - handle both JSON and FormData formats
    let sellerData;

    if (formData.sellerData && typeof formData.sellerData === "object") {
      // JSON format - nested object
      sellerData = {
        firstName: formData.sellerData.firstName || "",
        lastName: formData.sellerData.lastName || "",
        email: formData.sellerData.email || "",
        mobileNo: formData.sellerData.mobileNo || "",
        description:
          formData.sellerData.description || formData.kycDescription || "",
        driversLicense: formData.driversLicense || "",
      };
    } else {
      // FormData format - flattened with dot notation
      sellerData = {
        firstName: formData["sellerData.firstName"] || "",
        lastName: formData["sellerData.lastName"] || "",
        email: formData["sellerData.email"] || "",
        mobileNo: formData["sellerData.mobileNo"] || "",
        description:
          formData["sellerData.description"] || formData.kycDescription || "",
        driversLicense: formData.driversLicense || "",
      };
    }

    console.log("Mapped seller data:", sellerData);

    // Validate seller data
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

    // Prepare car intake data (excluding seller fields)
    const carIntakeData = {
      vin: formData.vin || "",
      year: parseInt(formData.year) || new Date().getFullYear(),
      make: formData.make || "",
      model: formData.model || "",
      trim: formData.trim || "",
      color: formData.color || "",
      bodyClass: formData.bodyClass || "",
      chassisNo: formData.chassisNo || "",
      engineNo: formData.engineNo || "",
      engineVariant: formData.engineVariant || "",
      drive: formData.drive || "",
      transmission: formData.transmission || "",
      scrapYardName: formData.scrapYardName || "",
      scrapYardLocation: formData.scrapYardLocation || "",
      fuelType: formData.fuelType || "",
      keys: formData.keys === "true" || false,
      weight: parseFloat(formData.weight) || 0,
      dimensions: formData.dimensions || "",
      description: formData.description || "",

      // Price information
      weightInPounds:
        parseFloat(formData.weightInPounds) ||
        parseFloat(formData.carWeight) ||
        0,
      ratePerPound:
        parseFloat(formData.ratePerPound) || parseFloat(formData.rate) || 6,
      actualPrice: parseFloat(formData.actualPrice) || 0,
      ourPrice: parseFloat(formData.ourPrice) || 0,
      customerPrice: parseFloat(formData.customerPrice) || 0,
      negotiateTo: formData.negotiateTo || "",
      finalPrice: parseFloat(formData.finalPrice) || 0,
      priceDescription: formData.priceDescription || "",

      // Dates and other info
      sellingDate:
        formData.sellingDate || new Date().toISOString().split("T")[0],
      pickupType: formData.pickupType || "You Pull",
      paymentMethod: formData.paymentMethod || "Cash",

      // Images and documents
      imageDescription: formData.imageDescription || "",
      partsDescription: formData.partsDescription || "",
      kycDescription: formData.kycDescription || "",
    };

    // Handle file uploads
    if (req.files && req.files.length > 0) {
      carIntakeData.carImages = {};
      carIntakeData.documents = {};

      req.files.forEach((file) => {
        if (file.fieldname.startsWith("carImages.")) {
          const imageKey = file.fieldname.split(".")[1];
          carIntakeData.carImages[imageKey] = file.path;
        } else if (file.fieldname.startsWith("documents.")) {
          const docKey = file.fieldname.split(".")[1];
          carIntakeData.documents[docKey] = file.path;
        }
      });
    }

    // Transaction data
    const transactionData = {
      description:
        formData.paymentDescription ||
        `Payment for ${carIntakeData.year} ${carIntakeData.make} ${carIntakeData.model}`,
    };

    // Start creating records (without MongoDB transactions for single node setup)
    try {
      // Step 1: Create Seller first
      const seller = new Seller({
        ...sellerData,
        createdBy: req.user._id,
      });
      await seller.save();

      // Step 2: Create Car Intake with seller reference
      const carIntake = new CarIntake({
        ...carIntakeData,
        seller: seller._id,
        createdBy: req.user._id,
      });
      await carIntake.save();

      // Step 3: Create Transaction with references to both
      const transaction = new Transaction({
        type: "credit", // Payment to seller
        amount: carIntake.finalPrice,
        paymentMethod: carIntake.paymentMethod,
        description:
          carIntake.paymentDescription ||
          `Payment for ${carIntake.year} ${carIntake.make} ${carIntake.model}`,
        carIntake: carIntake._id,
        seller: seller._id,
        status: "completed",
        createdBy: req.user._id,
        ...transactionData,
      });
      await transaction.save();

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
      if (sellerData && carIntake.seller) {
        await Seller.findByIdAndUpdate(carIntake.seller, {
          ...sellerData,
          updatedBy: req.user._id,
        });
      }

      // Update car intake
      Object.assign(carIntake, carIntakeData);
      await carIntake.save();

      // Update transaction if payment details changed
      if (
        transactionData ||
        carIntake.paidAmount !== carIntakeData.paidAmount
      ) {
        await Transaction.findOneAndUpdate(
          { carIntake: carIntake._id },
          {
            amount: carIntakeData.paidAmount || carIntake.paidAmount,
            paymentMethod:
              carIntakeData.paymentMethod || carIntake.paymentMethod,
            description:
              carIntakeData.paymentDescription || carIntake.paymentDescription,
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

    if (!["intake", "in-progress", "completed", "cancelled"].includes(status)) {
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
