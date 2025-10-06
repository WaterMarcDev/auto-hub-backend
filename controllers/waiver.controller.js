const Waiver = require("../models/Waiver.model");
const Seller = require("../models/Seller");
const Buyer = require("../models/Buyer.model");
const Transaction = require("../models/Transaction");
const { validationResult } = require("express-validator");

// @desc    Create new waiver
// @route   POST /api/waivers
// @access  Private
const createWaiver = async (req, res) => {
  try {
    console.log("Received waiver data:", req.body);

    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: "Validation failed",
        details: errors.array(),
      });
    }

    const {
      sellerId,
      sellerData,
      buyerId,
      buyerData,
      transactionData,
      customerType,
      idProofType,
      idProofNumber,
      idProofImage,
      signatureImage,
      employeeSignature,
    } = req.body;

    // Validate customerType
    if (!customerType) {
      return res.status(400).json({
        error: "customerType is required",
        details: "customerType must be either 'seller' or 'buyer'",
      });
    }

    if (!["seller", "buyer"].includes(customerType)) {
      return res.status(400).json({
        error: "Invalid customerType",
        details: "customerType must be either 'seller' or 'buyer'",
      });
    }

    const waiverData = {
      customerType: customerType,
      idProofType: idProofType || undefined,
      idProofNumber: idProofNumber || undefined,
      idProofImage: idProofImage || undefined,
      signatureImage: signatureImage || undefined,
      employeeSignature: employeeSignature || undefined,
      createdBy: req.user._id,
    };

    let seller = null;
    let buyer = null;
    let transaction = null;

    // Handle Seller - only if customerType is "seller"
    if (customerType === "seller") {
      if (sellerId) {
        seller = await Seller.findById(sellerId);
        if (!seller || !seller.isActive) {
          return res.status(400).json({ error: "Invalid seller ID" });
        }
        waiverData.seller = seller._id;
      } else if (sellerData) {
        // Validate required seller fields (email and mobileNo are now optional)
        if (!sellerData.firstName || !sellerData.lastName) {
          return res.status(400).json({
            error: "Missing required seller data",
            details: {
              firstName: sellerData.firstName || "missing",
              lastName: sellerData.lastName || "missing",
            },
          });
        }

        // Check if seller already exists (only if email or mobileNo provided)
        let existingSeller = null;
        if (sellerData.email || sellerData.mobileNo) {
          const query = [];
          if (sellerData.email) query.push({ email: sellerData.email });
          if (sellerData.mobileNo)
            query.push({ mobileNo: sellerData.mobileNo });

          existingSeller = await Seller.findOne({
            $or: query,
            isActive: true,
          });
        }

        if (existingSeller) {
          seller = existingSeller;
          waiverData.seller = seller._id;
        } else {
          // Create new seller
          seller = new Seller({
            firstName: sellerData.firstName,
            lastName: sellerData.lastName,
            email: sellerData.email,
            mobileNo: sellerData.mobileNo,

            createdBy: req.user._id,
          });
          await seller.save();
          waiverData.seller = seller._id;
        }
      } else {
        return res.status(400).json({
          error: "Seller information required",
          details:
            "Either sellerId or sellerData must be provided when customerType is 'seller'",
        });
      }
    }

    // Handle Buyer - only if customerType is "buyer"
    if (customerType === "buyer") {
      if (buyerId) {
        buyer = await Buyer.findById(buyerId);
        if (!buyer || !buyer.isActive) {
          return res.status(400).json({ error: "Invalid buyer ID" });
        }
        waiverData.buyer = buyer._id;
      } else if (buyerData) {
        // Validate required buyer fields
        if (!buyerData.firstName || !buyerData.lastName) {
          return res.status(400).json({
            error: "Missing required buyer data",
            details: {
              firstName: buyerData.firstName || "missing",
              lastName: buyerData.lastName || "missing",
            },
          });
        }

        // Check if buyer already exists (by email or mobile if provided)
        let existingBuyer = null;
        if (buyerData.email || buyerData.mobileNo) {
          const searchCriteria = [];
          if (buyerData.email) searchCriteria.push({ email: buyerData.email });
          if (buyerData.mobileNo)
            searchCriteria.push({ mobileNo: buyerData.mobileNo });

          existingBuyer = await Buyer.findOne({
            $or: searchCriteria,
            isActive: true,
          });
        }

        if (existingBuyer) {
          buyer = existingBuyer;
          waiverData.buyer = buyer._id;
        } else {
          // Create new buyer
          buyer = new Buyer({
            firstName: buyerData.firstName,
            lastName: buyerData.lastName,
            email: buyerData.email || undefined,
            mobileNo: buyerData.mobileNo || undefined,
            description: buyerData.description || "",
            createdBy: req.user._id,
          });
          await buyer.save();
          waiverData.buyer = buyer._id;
        }
      } else {
        return res.status(400).json({
          error: "Buyer information required",
          details:
            "Either buyerId or buyerData must be provided when customerType is 'buyer'",
        });
      }
    }

    // Handle Transaction - create new from transaction data
    if (transactionData) {
      // Validate required transaction fields
      if (transactionData.amount === undefined) {
        return res.status(400).json({
          error: "Missing required transaction data",
          details: {
            amount: "missing",
          },
        });
      }

      // Set transaction type as credit for both seller and buyer
      const transactionType = "credit";

      // Create new transaction
      transaction = new Transaction({
        type: transactionType,
        amount: parseFloat(transactionData.amount),
        paymentMethod: transactionData.paymentMethod || undefined,
        description:
          transactionData.description || "Payment for waiver transaction",
        status: "completed", // Always set to completed
        // transactionDate will be auto-handled by DB timestamp (createdAt)
        seller: seller?._id,
        buyer: buyer?._id,
        carIntake: transactionData.carIntake || undefined,
        createdBy: req.user._id,
      });
      await transaction.save();
      waiverData.payment = transaction._id;
    }

    // Create waiver
    const waiver = new Waiver(waiverData);
    await waiver.save();

    // Populate references for response
    const populatedWaiver = await Waiver.findById(waiver._id)
      .populate("seller", "firstName lastName email mobileNo driversLicense")
      .populate("buyer", "firstName lastName email mobileNo")
      .populate("payment")
      .populate("createdBy", "first_name last_name email");

    res.status(201).json({
      message: "Waiver created successfully",
      waiver: populatedWaiver,
      seller: seller,
      buyer: buyer,
      transaction: transaction,
    });
  } catch (error) {
    console.error("Create waiver error:", error);
    res.status(500).json({
      error: "Server error during waiver creation",
      details: error.message,
    });
  }
};

// @desc    Get all waivers
// @route   GET /api/waivers
// @access  Private
const getWaivers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Build filter object
    const filter = {};

    // Search functionality
    if (req.query.search) {
      const searchTerm = String(req.query.search).trim();
      if (searchTerm.length) {
        const re = new RegExp(
          searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "i"
        );

        // Find sellers and buyers that match search
        let sellerIds = [];
        let buyerIds = [];

        try {
          const sellers = await Seller.find({
            $or: [
              { email: re },
              { firstName: re },
              { lastName: re },
              { mobileNo: re },
            ],
          }).select("_id");
          sellerIds = sellers.map((s) => s._id);

          const buyers = await Buyer.find({
            $or: [
              { email: re },
              { firstName: re },
              { lastName: re },
              { mobileNo: re },
            ],
          }).select("_id");
          buyerIds = buyers.map((b) => b._id);
        } catch (e) {
          // Ignore lookup errors
        }

        const orArray = [{ idProofType: re }, { idProofNumber: re }];
        if (sellerIds.length) orArray.push({ seller: { $in: sellerIds } });
        if (buyerIds.length) orArray.push({ buyer: { $in: buyerIds } });

        filter.$or = orArray;
      }
    }

    // Filter by seller
    if (req.query.sellerId) {
      filter.seller = req.query.sellerId;
    }

    // Filter by buyer
    if (req.query.buyerId) {
      filter.buyer = req.query.buyerId;
    }

    // Date range filter
    if (req.query.startDate || req.query.endDate) {
      filter.createdAt = {};
      if (req.query.startDate) {
        filter.createdAt.$gte = new Date(req.query.startDate);
      }
      if (req.query.endDate) {
        filter.createdAt.$lte = new Date(req.query.endDate);
      }
    }

    const waivers = await Waiver.find(filter)
      .populate("seller", "firstName lastName email mobileNo driversLicense")
      .populate("buyer", "firstName lastName email mobileNo")
      .populate("payment")
      .populate("createdBy", "first_name last_name email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Waiver.countDocuments(filter);

    res.json({
      waivers,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Get waivers error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Get single waiver
// @route   GET /api/waivers/:id
// @access  Private
const getWaiver = async (req, res) => {
  try {
    const waiver = await Waiver.findById(req.params.id)
      .populate(
        "seller",
        "firstName lastName email mobileNo driversLicense description"
      )
      .populate("buyer", "firstName lastName email mobileNo description")
      .populate("payment")
      .populate("createdBy", "first_name last_name email");

    if (!waiver) {
      return res.status(404).json({ error: "Waiver not found" });
    }

    res.json({ waiver });
  } catch (error) {
    console.error("Get waiver error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Update waiver
// @route   PUT /api/waivers/:id
// @access  Private
const updateWaiver = async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: "Validation failed",
        details: errors.array(),
      });
    }

    const waiver = await Waiver.findById(req.params.id);
    if (!waiver) {
      return res.status(404).json({ error: "Waiver not found" });
    }

    const {
      sellerId,
      buyerId,
      transactionData,
      customerType,
      idProofType,
      idProofNumber,
      idProofImage,
      signatureImage,
      employeeSignature,
    } = req.body;

    // Validate customerType if provided
    if (customerType && !["seller", "buyer"].includes(customerType)) {
      return res.status(400).json({
        error: "Invalid customerType",
        details: "customerType must be either 'seller' or 'buyer'",
      });
    }

    // Update seller if provided
    if (sellerId) {
      const seller = await Seller.findById(sellerId);
      if (!seller || !seller.isActive) {
        return res.status(400).json({ error: "Invalid seller ID" });
      }
      waiver.seller = seller._id;
    }

    // Update buyer if provided
    if (buyerId) {
      const buyer = await Buyer.findById(buyerId);
      if (!buyer || !buyer.isActive) {
        return res.status(400).json({ error: "Invalid buyer ID" });
      }
      waiver.buyer = buyer._id;
    }

    // Update transaction if provided
    if (transactionData) {
      // If waiver already has a payment/transaction, update it
      if (waiver.payment) {
        await Transaction.findByIdAndUpdate(waiver.payment, {
          type: transactionData.type,
          amount: parseFloat(transactionData.amount),
          paymentMethod: transactionData.paymentMethod,
          description: transactionData.description,
          status: transactionData.status,
          transactionDate: transactionData.transactionDate,
          seller: waiver.seller,
          buyer: waiver.buyer,
          carIntake: transactionData.carIntake,
        });
      } else {
        // Create new transaction
        const newTransaction = new Transaction({
          type: transactionData.type,
          amount: parseFloat(transactionData.amount),
          paymentMethod: transactionData.paymentMethod || undefined,
          description:
            transactionData.description || "Payment for waiver transaction",
          status: transactionData.status || "completed",
          transactionDate: transactionData.transactionDate || Date.now(),
          seller: waiver.seller,
          buyer: waiver.buyer,
          carIntake: transactionData.carIntake || undefined,
          createdBy: req.user._id,
        });
        await newTransaction.save();
        waiver.payment = newTransaction._id;
      }
    }

    // Update other fields
    if (customerType !== undefined) waiver.customerType = customerType;
    if (idProofType !== undefined) waiver.idProofType = idProofType;
    if (idProofNumber !== undefined) waiver.idProofNumber = idProofNumber;
    if (idProofImage !== undefined) waiver.idProofImage = idProofImage;
    if (signatureImage !== undefined) waiver.signatureImage = signatureImage;
    if (employeeSignature !== undefined)
      waiver.employeeSignature = employeeSignature;

    await waiver.save();

    // Populate references for response
    const updatedWaiver = await Waiver.findById(waiver._id)
      .populate("seller", "firstName lastName email mobileNo driversLicense")
      .populate("buyer", "firstName lastName email mobileNo")
      .populate("payment")
      .populate("createdBy", "first_name last_name email");

    res.json({
      message: "Waiver updated successfully",
      waiver: updatedWaiver,
    });
  } catch (error) {
    console.error("Update waiver error:", error);
    res.status(500).json({
      error: "Server error during update",
      details: error.message,
    });
  }
};

// @desc    Delete waiver
// @route   DELETE /api/waivers/:id
// @access  Private
const deleteWaiver = async (req, res) => {
  try {
    const waiver = await Waiver.findById(req.params.id);
    if (!waiver) {
      return res.status(404).json({ error: "Waiver not found" });
    }

    // Hard delete the waiver
    await Waiver.findByIdAndDelete(req.params.id);

    res.json({ message: "Waiver deleted successfully" });
  } catch (error) {
    console.error("Delete waiver error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Get waivers by seller
// @route   GET /api/waivers/seller/:sellerId
// @access  Private
const getWaiversBySeller = async (req, res) => {
  try {
    const seller = await Seller.findById(req.params.sellerId);
    if (!seller || !seller.isActive) {
      return res.status(404).json({ error: "Seller not found" });
    }

    const waivers = await Waiver.find({ seller: seller._id })
      .populate("buyer", "firstName lastName email mobileNo")
      .populate("payment")
      .populate("createdBy", "first_name last_name email")
      .sort({ createdAt: -1 });

    res.json({
      seller: {
        id: seller._id,
        fullName: seller.fullName,
        email: seller.email,
        mobileNo: seller.mobileNo,
      },
      waivers,
    });
  } catch (error) {
    console.error("Get seller waivers error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Get waivers by buyer
// @route   GET /api/waivers/buyer/:buyerId
// @access  Private
const getWaiversByBuyer = async (req, res) => {
  try {
    const buyer = await Buyer.findById(req.params.buyerId);
    if (!buyer || !buyer.isActive) {
      return res.status(404).json({ error: "Buyer not found" });
    }

    const waivers = await Waiver.find({ buyer: buyer._id })
      .populate("seller", "firstName lastName email mobileNo")
      .populate("payment")
      .populate("createdBy", "first_name last_name email")
      .sort({ createdAt: -1 });

    res.json({
      buyer: {
        id: buyer._id,
        fullName: buyer.fullName,
        email: buyer.email,
        mobileNo: buyer.mobileNo,
      },
      waivers,
    });
  } catch (error) {
    console.error("Get buyer waivers error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Get waiver statistics
// @route   GET /api/waivers/stats
// @access  Private
const getWaiverStats = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const matchStage = {};
    if (startDate || endDate) {
      matchStage.createdAt = {};
      if (startDate) matchStage.createdAt.$gte = new Date(startDate);
      if (endDate) matchStage.createdAt.$lte = new Date(endDate);
    }

    const totalCount = await Waiver.countDocuments(matchStage);

    // Count waivers with/without payment
    const withPayment = await Waiver.countDocuments({
      ...matchStage,
      payment: { $exists: true, $ne: null },
    });
    const withoutPayment = totalCount - withPayment;

    // Group by ID proof type
    const byIdProofType = await Waiver.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: "$idProofType",
          count: { $sum: 1 },
        },
      },
    ]);

    // Get recent waivers
    const recentWaivers = await Waiver.find(matchStage)
      .populate("seller", "firstName lastName")
      .populate("buyer", "firstName lastName")
      .sort({ createdAt: -1 })
      .limit(5)
      .select("seller buyer idProofType createdAt");

    res.json({
      summary: {
        totalCount,
        withPayment,
        withoutPayment,
      },
      byIdProofType,
      recentWaivers,
    });
  } catch (error) {
    console.error("Get waiver stats error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = {
  createWaiver,
  getWaivers,
  getWaiver,
  updateWaiver,
  deleteWaiver,
  getWaiversBySeller,
  getWaiversByBuyer,
  getWaiverStats,
};
