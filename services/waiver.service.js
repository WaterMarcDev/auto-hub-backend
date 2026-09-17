/**
 * Waiver business logic. Extracted 1:1 from controllers/waiver.controller.js
 * during the clean-architecture migration — every validation branch,
 * dedupe-by-email/mobile lookup, and inline Seller/Buyer/Transaction
 * creation is preserved exactly.
 */
const waiverRepository = require("../repositories/waiver.repository");
const sellerRepository = require("../repositories/seller.repository");
const buyerRepository = require("../repositories/buyer.repository");
const transactionRepository = require("../repositories/transaction.repository");

const WAIVER_SELLER_POPULATE = "firstName lastName email mobileNo driversLicense";
const WAIVER_BUYER_POPULATE = "firstName lastName email mobileNo";

function httpError(statusCode, error, details) {
  const err = new Error(error);
  err.statusCode = statusCode;
  err.responseError = error;
  if (details !== undefined) err.details = details;
  return err;
}

async function createWaiver(body, userId) {
  console.log("Received waiver data:", body);

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
  } = body;

  if (!customerType) {
    throw httpError(400, "customerType is required", "customerType must be either 'seller' or 'buyer'");
  }

  if (!["seller", "buyer"].includes(customerType)) {
    throw httpError(400, "Invalid customerType", "customerType must be either 'seller' or 'buyer'");
  }

  const waiverData = {
    customerType,
    idProofType: idProofType || undefined,
    idProofNumber: idProofNumber || undefined,
    idProofImage: idProofImage || undefined,
    signatureImage: signatureImage || undefined,
    employeeSignature: employeeSignature || undefined,
    createdBy: userId,
  };

  let seller = null;
  let buyer = null;
  let transaction = null;

  // Handle Seller - only if customerType is "seller"
  if (customerType === "seller") {
    if (sellerId) {
      seller = await sellerRepository.findById(sellerId);
      if (!seller || !seller.isActive) {
        throw httpError(400, "Invalid seller ID");
      }
      waiverData.seller = seller._id;
    } else if (sellerData) {
      if (!sellerData.firstName || !sellerData.lastName) {
        throw httpError(400, "Missing required seller data", {
          firstName: sellerData.firstName || "missing",
          lastName: sellerData.lastName || "missing",
        });
      }

      let existingSeller = null;
      if (sellerData.email || sellerData.mobileNo) {
        const query = [];
        if (sellerData.email) query.push({ email: sellerData.email });
        if (sellerData.mobileNo) query.push({ mobileNo: sellerData.mobileNo });

        existingSeller = await sellerRepository.findOne({ $or: query, isActive: true });
      }

      if (existingSeller) {
        seller = existingSeller;
        waiverData.seller = seller._id;
      } else {
        seller = sellerRepository.build({
          firstName: sellerData.firstName,
          lastName: sellerData.lastName,
          email: sellerData.email,
          mobileNo: sellerData.mobileNo,
          createdBy: userId,
        });
        await sellerRepository.save(seller);
        waiverData.seller = seller._id;
      }
    } else {
      throw httpError(400, "Seller information required", "Either sellerId or sellerData must be provided when customerType is 'seller'");
    }
  }

  // Handle Buyer - only if customerType is "buyer"
  if (customerType === "buyer") {
    if (buyerId) {
      buyer = await buyerRepository.findById(buyerId);
      if (!buyer || !buyer.isActive) {
        throw httpError(400, "Invalid buyer ID");
      }
      waiverData.buyer = buyer._id;
    } else if (buyerData) {
      if (!buyerData.firstName || !buyerData.lastName) {
        throw httpError(400, "Missing required buyer data", {
          firstName: buyerData.firstName || "missing",
          lastName: buyerData.lastName || "missing",
        });
      }

      let existingBuyer = null;
      if (buyerData.email || buyerData.mobileNo) {
        const searchCriteria = [];
        if (buyerData.email) searchCriteria.push({ email: buyerData.email });
        if (buyerData.mobileNo) searchCriteria.push({ mobileNo: buyerData.mobileNo });

        existingBuyer = await buyerRepository.findOne({ $or: searchCriteria, isActive: true });
      }

      if (existingBuyer) {
        buyer = existingBuyer;
        waiverData.buyer = buyer._id;
      } else {
        buyer = buyerRepository.build({
          firstName: buyerData.firstName,
          lastName: buyerData.lastName,
          email: buyerData.email || undefined,
          mobileNo: buyerData.mobileNo || undefined,
          description: buyerData.description || "",
          createdBy: userId,
        });
        await buyerRepository.save(buyer);
        waiverData.buyer = buyer._id;
      }
    } else {
      throw httpError(400, "Buyer information required", "Either buyerId or buyerData must be provided when customerType is 'buyer'");
    }
  }

  // Handle Transaction - create new from transaction data
  if (transactionData) {
    if (transactionData.amount === undefined) {
      throw httpError(400, "Missing required transaction data", { amount: "missing" });
    }

    const transactionType = "credit";

    transaction = transactionRepository.build({
      type: transactionType,
      amount: parseFloat(transactionData.amount),
      paymentMethod: transactionData.paymentMethod || undefined,
      description: transactionData.description || "Payment for waiver transaction",
      status: "completed", // Always set to completed
      seller: seller?._id,
      buyer: buyer?._id,
      carIntake: transactionData.carIntake || undefined,
      createdBy: userId,
    });
    await transactionRepository.save(transaction);
    waiverData.payment = transaction._id;
  }

  const waiver = waiverRepository.build(waiverData);
  await waiverRepository.save(waiver);

  const populatedWaiver = await waiverRepository
    .findById(waiver._id)
    .populate("seller", "firstName lastName email mobileNo driversLicense")
    .populate("buyer", WAIVER_BUYER_POPULATE)
    .populate("payment")
    .populate("createdBy", "first_name last_name email");

  return { waiver: populatedWaiver, seller, buyer, transaction };
}

async function getWaivers(query) {
  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 10;
  const skip = (page - 1) * limit;

  const filter = {};

  if (query.search) {
    const searchTerm = String(query.search).trim();
    if (searchTerm.length) {
      const re = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

      let sellerIds = [];
      let buyerIds = [];

      try {
        const sellers = await sellerRepository
          .find({ $or: [{ email: re }, { firstName: re }, { lastName: re }, { mobileNo: re }] })
          .select("_id");
        sellerIds = sellers.map((s) => s._id);

        const buyers = await buyerRepository
          .find({ $or: [{ email: re }, { firstName: re }, { lastName: re }, { mobileNo: re }] })
          .select("_id");
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

  if (query.sellerId) filter.seller = query.sellerId;
  if (query.buyerId) filter.buyer = query.buyerId;

  if (query.startDate || query.endDate) {
    filter.createdAt = {};
    if (query.startDate) filter.createdAt.$gte = new Date(query.startDate);
    if (query.endDate) filter.createdAt.$lte = new Date(query.endDate);
  }

  const waivers = await waiverRepository
    .find(filter)
    .populate("seller", "firstName lastName email mobileNo driversLicense")
    .populate("buyer", WAIVER_BUYER_POPULATE)
    .populate("payment")
    .populate("createdBy", "first_name last_name email")
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  // Exclude soft-deleted documents — NOTE: this filter mutation happens
  // AFTER the .find() call above runs, exactly as in the original code
  // (a pre-existing quirk: the listed `waivers` page is NOT filtered by
  // isDeleted, only the `total` count is — preserved verbatim, not "fixed").
  filter.isDeleted = { $ne: true };

  const total = await waiverRepository.countDocuments(filter);

  return {
    waivers,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

async function getWaiver(id) {
  const waiver = await waiverRepository
    .findOne({ _id: id, isDeleted: { $ne: true } })
    .populate("seller", "firstName lastName email mobileNo driversLicense description")
    .populate("buyer", "firstName lastName email mobileNo description")
    .populate("payment")
    .populate("createdBy", "first_name last_name email");

  if (!waiver) {
    throw httpError(404, "Waiver not found");
  }
  return waiver;
}

async function updateWaiver(id, body, userId) {
  const waiver = await waiverRepository.findById(id);
  if (!waiver) {
    throw httpError(404, "Waiver not found");
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
  } = body;

  if (customerType && !["seller", "buyer"].includes(customerType)) {
    throw httpError(400, "Invalid customerType", "customerType must be either 'seller' or 'buyer'");
  }

  if (sellerId) {
    const seller = await sellerRepository.findById(sellerId);
    if (!seller || !seller.isActive) {
      throw httpError(400, "Invalid seller ID");
    }
    waiver.seller = seller._id;
  }

  if (buyerId) {
    const buyer = await buyerRepository.findById(buyerId);
    if (!buyer || !buyer.isActive) {
      throw httpError(400, "Invalid buyer ID");
    }
    waiver.buyer = buyer._id;
  }

  if (transactionData) {
    if (waiver.payment) {
      await transactionRepository.findByIdAndUpdate(waiver.payment, {
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
      const newTransaction = transactionRepository.build({
        type: transactionData.type,
        amount: parseFloat(transactionData.amount),
        paymentMethod: transactionData.paymentMethod || undefined,
        description: transactionData.description || "Payment for waiver transaction",
        status: transactionData.status || "completed",
        transactionDate: transactionData.transactionDate || Date.now(),
        seller: waiver.seller,
        buyer: waiver.buyer,
        carIntake: transactionData.carIntake || undefined,
        createdBy: userId,
      });
      await transactionRepository.save(newTransaction);
      waiver.payment = newTransaction._id;
    }
  }

  if (customerType !== undefined) waiver.customerType = customerType;
  if (idProofType !== undefined) waiver.idProofType = idProofType;
  if (idProofNumber !== undefined) waiver.idProofNumber = idProofNumber;
  if (idProofImage !== undefined) waiver.idProofImage = idProofImage;
  if (signatureImage !== undefined) waiver.signatureImage = signatureImage;
  if (employeeSignature !== undefined) waiver.employeeSignature = employeeSignature;

  await waiverRepository.save(waiver);

  return waiverRepository
    .findById(waiver._id)
    .populate("seller", "firstName lastName email mobileNo driversLicense")
    .populate("buyer", WAIVER_BUYER_POPULATE)
    .populate("payment")
    .populate("createdBy", "first_name last_name email");
}

async function deleteWaiver(id) {
  const waiver = await waiverRepository.findById(id);
  if (!waiver || waiver.isDeleted) {
    throw httpError(404, "Waiver not found");
  }

  waiver.isDeleted = true;
  waiver.deletedAt = new Date();
  if (typeof waiver.isActive !== "undefined") waiver.isActive = false;
  await waiverRepository.save(waiver);
}

async function getWaiversBySeller(sellerId) {
  const seller = await sellerRepository.findById(sellerId);
  if (!seller || !seller.isActive) {
    throw httpError(404, "Seller not found");
  }

  const waivers = await waiverRepository
    .find({ seller: seller._id })
    .populate("buyer", WAIVER_BUYER_POPULATE)
    .populate("payment")
    .populate("createdBy", "first_name last_name email")
    .sort({ createdAt: -1 });

  return {
    seller: { id: seller._id, fullName: seller.fullName, email: seller.email, mobileNo: seller.mobileNo },
    waivers,
  };
}

async function getWaiversByBuyer(buyerId) {
  const buyer = await buyerRepository.findById(buyerId);
  if (!buyer || !buyer.isActive) {
    throw httpError(404, "Buyer not found");
  }

  const waivers = await waiverRepository
    .find({ buyer: buyer._id })
    .populate("seller", WAIVER_SELLER_POPULATE)
    .populate("payment")
    .populate("createdBy", "first_name last_name email")
    .sort({ createdAt: -1 });

  return {
    buyer: { id: buyer._id, fullName: buyer.fullName, email: buyer.email, mobileNo: buyer.mobileNo },
    waivers,
  };
}

async function getWaiverStats(query) {
  const { startDate, endDate } = query;

  const matchStage = {};
  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = new Date(startDate);
    if (endDate) matchStage.createdAt.$lte = new Date(endDate);
  }

  const totalCount = await waiverRepository.countDocuments(matchStage);

  const withPayment = await waiverRepository.countDocuments({
    ...matchStage,
    payment: { $exists: true, $ne: null },
  });
  const withoutPayment = totalCount - withPayment;

  const byIdProofType = await waiverRepository.aggregate([
    { $match: matchStage },
    { $group: { _id: "$idProofType", count: { $sum: 1 } } },
  ]);

  const recentWaivers = await waiverRepository
    .find(matchStage)
    .populate("seller", "firstName lastName")
    .populate("buyer", "firstName lastName")
    .sort({ createdAt: -1 })
    .limit(5)
    .select("seller buyer idProofType createdAt");

  return {
    summary: { totalCount, withPayment, withoutPayment },
    byIdProofType,
    recentWaivers,
  };
}

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
