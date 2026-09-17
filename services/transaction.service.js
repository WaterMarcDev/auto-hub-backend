/**
 * Transaction business logic. Extracted 1:1 from
 * controllers/transactionController.js during the clean-architecture
 * migration — every filter, populate path, status transition, and the
 * junk-car/car-intake side effect on completion are preserved exactly.
 */
const transactionRepository = require("../repositories/transaction.repository");
const carIntakeRepository = require("../repositories/carIntake.repository");
const sellerRepository = require("../repositories/seller.repository");
const junkCarRepository = require("../repositories/junkCar.repository");

const SELLER_POPULATE_FIELDS = "firstName lastName email mobileNo driversLicense description";

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function createTransaction(body, userId) {
  const transaction = transactionRepository.build({ ...body, createdBy: userId });
  await transactionRepository.save(transaction);

  return transactionRepository
    .findById(transaction._id)
    .populate("carIntake", "vin make model year")
    .populate("seller", SELLER_POPULATE_FIELDS)
    .populate("createdBy", "first_name last_name email");
}

async function getTransactions(query) {
  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 10;
  const skip = (page - 1) * limit;

  const filter = { isActive: true };
  if (query.type) filter.type = query.type;
  if (query.status) filter.status = query.status;
  if (query.paymentMethod) filter.paymentMethod = query.paymentMethod;
  if (query.startDate || query.endDate) {
    filter.transactionDate = {};
    if (query.startDate) filter.transactionDate.$gte = new Date(query.startDate);
    if (query.endDate) filter.transactionDate.$lte = new Date(query.endDate);
  }

  const transactions = await transactionRepository
    .find(filter)
    .populate("carIntake", "vin make model year finalPrice")
    .populate("seller", SELLER_POPULATE_FIELDS)
    .populate("createdBy", "first_name last_name email")
    .sort({ transactionDate: -1 })
    .skip(skip)
    .limit(limit);

  const total = await transactionRepository.countDocuments(filter);

  return {
    transactions,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

async function getTransaction(id) {
  const transaction = await transactionRepository
    .findById(id)
    .populate("carIntake", "vin make model year finalPrice status")
    .populate("seller", SELLER_POPULATE_FIELDS)
    .populate("createdBy", "first_name last_name email");

  if (!transaction || !transaction.isActive) {
    throw notFoundError("Transaction not found");
  }
  return transaction;
}

async function updateTransaction(id, body) {
  const transaction = await transactionRepository.findById(id);
  if (!transaction || !transaction.isActive) {
    throw notFoundError("Transaction not found");
  }

  Object.assign(transaction, body);
  await transactionRepository.save(transaction);

  return transactionRepository
    .findById(transaction._id)
    .populate("carIntake", "vin make model year finalPrice")
    .populate("seller", SELLER_POPULATE_FIELDS)
    .populate("createdBy", "first_name last_name email");
}

async function updateTransactionStatus(id, status) {
  if (!["pending", "completed", "failed", "cancelled"].includes(status)) {
    throw badRequestError("Invalid status");
  }

  const transaction = await transactionRepository
    .findByIdAndUpdate(id, { status }, { new: true })
    .populate("carIntake", "vin make model year")
    .populate("seller", SELLER_POPULATE_FIELDS);

  // paymentStatus for junk car by shiva
  if (status === "completed") {
    const junk = await junkCarRepository.findById(transaction.junkCar);

    if (junk) {
      junk.paymentStatus = "Paid";
      junk.status = "completed";
      await junkCarRepository.save(junk);

      console.log("JunkCar marked as completed after payment");

      const vinValue =
        junk.engineOrVin && junk.engineOrVin !== "none" && junk.engineOrVin.trim().length > 5
          ? junk.engineOrVin.toUpperCase()
          : `JUNK${Date.now()}`;

      const existing = await carIntakeRepository.findOne({ vin: vinValue });

      if (!existing) {
        await carIntakeRepository.create({
          vin: vinValue,
          carDetails: {
            year: junk.year || null,
            make: junk.make || "",
            model: junk.model || "",
            trim: "Junk Car",
            description: "Auto added after payment completion",
          },
          status: "intake",
        });

        console.log("Car Intake Created Successfully ✅");
      } else {
        console.log("Duplicate VIN - Skipped");
      }
    }
  }
  // end here

  if (!transaction) {
    throw notFoundError("Transaction not found");
  }

  return transaction;
}

async function deleteTransaction(id) {
  const transaction = await transactionRepository.findById(id);
  if (!transaction || !transaction.isActive) {
    throw notFoundError("Transaction not found");
  }

  transaction.isActive = false;
  await transactionRepository.save(transaction);
}

async function getTransactionsByCarIntake(carIntakeId) {
  const carIntake = await carIntakeRepository.findById(carIntakeId);
  if (!carIntake) {
    throw notFoundError("Car intake not found");
  }

  const transactions = await transactionRepository
    .find({ carIntake: carIntakeId, isActive: true })
    .populate("seller", SELLER_POPULATE_FIELDS)
    .populate("createdBy", "first_name last_name email")
    .sort({ transactionDate: -1 });

  return {
    carIntake: {
      id: carIntake._id,
      vin: carIntake.vin,
      make: carIntake.make,
      model: carIntake.model,
      year: carIntake.year,
    },
    transactions,
  };
}

async function getTransactionsBySeller(sellerId) {
  const seller = await sellerRepository.findById(sellerId);
  if (!seller) {
    throw notFoundError("Seller not found");
  }

  const transactions = await transactionRepository
    .find({ seller: sellerId, isActive: true })
    .populate("carIntake", "vin make model year")
    .populate("createdBy", "first_name last_name email")
    .sort({ transactionDate: -1 });

  return {
    seller: {
      id: seller._id,
      fullName: seller.fullName,
      email: seller.email,
      mobileNo: seller.mobileNo,
    },
    transactions,
  };
}

async function getTransactionStats(query) {
  const { startDate, endDate, type } = query;

  const matchStage = { isActive: true };
  if (startDate || endDate) {
    matchStage.transactionDate = {};
    if (startDate) matchStage.transactionDate.$gte = new Date(startDate);
    if (endDate) matchStage.transactionDate.$lte = new Date(endDate);
  }
  if (type) {
    matchStage.type = type;
  }

  const stats = await transactionRepository.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: { type: "$type", status: "$status", paymentMethod: "$paymentMethod" },
        count: { $sum: 1 },
        totalAmount: { $sum: "$amount" },
        averageAmount: { $avg: "$amount" },
      },
    },
  ]);

  const summary = await transactionRepository.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: "$type",
        count: { $sum: 1 },
        totalAmount: { $sum: "$amount" },
      },
    },
  ]);

  const dailyStats = await transactionRepository.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: "%Y-%m-%d", date: "$transactionDate" } },
          type: "$type",
        },
        count: { $sum: 1 },
        totalAmount: { $sum: "$amount" },
      },
    },
    { $sort: { "_id.date": -1 } },
    { $limit: 30 }, // Last 30 days
  ]);

  return { stats, summary, dailyStats };
}

module.exports = {
  createTransaction,
  getTransactions,
  getTransaction,
  updateTransaction,
  updateTransactionStatus,
  deleteTransaction,
  getTransactionsByCarIntake,
  getTransactionsBySeller,
  getTransactionStats,
};
