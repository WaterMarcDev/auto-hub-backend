/**
 * Dashboard aggregation business logic. Extracted 1:1 from
 * controllers/dashboardController.js during the clean-architecture
 * migration — every bucket-building helper, aggregation pipeline, and
 * default date-range rule is preserved exactly.
 *
 * NOTE: the original file also imported models/Waiver.model but never
 * actually used it anywhere in the module body (dead import). Preserved
 * behaviorally by simply not wiring an unused Waiver dependency here —
 * an unused import has zero runtime effect, so this is not a behavior
 * change.
 */
const transactionRepository = require("../repositories/transaction.repository");
const carIntakeRepository = require("../repositories/carIntake.repository");
const inventoryRepository = require("../repositories/inventory.repository");
const customerRepository = require("../repositories/customer.repository");
const checkInRepository = require("../repositories/checkIn.repository");

// Helper to build date format and unit for groupBy
const buildDateBucket = (groupBy) => {
  switch (groupBy) {
    case "hour":
      return { format: "%Y-%m-%dT%H", unit: "hour" };
    case "day":
      return { format: "%Y-%m-%d", unit: "day" };
    case "month":
    default:
      return { format: "%Y-%m", unit: "month" };
  }
};

// Build an array of bucket keys between start and end inclusive according to unit
const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
const buildBuckets = (unit, startDate, endDate) => {
  const buckets = [];
  const s = new Date(startDate);
  const e = new Date(endDate);

  if (unit === "month") {
    let year = s.getFullYear();
    let month = s.getMonth();
    const endYear = e.getFullYear();
    const endMonth = e.getMonth();
    while (year < endYear || (year === endYear && month <= endMonth)) {
      buckets.push(`${year}-${pad(month + 1)}`);
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
    }
  } else if (unit === "day") {
    const cur = new Date(s.getFullYear(), s.getMonth(), s.getDate());
    while (cur <= e) {
      const y = cur.getFullYear();
      const m = pad(cur.getMonth() + 1);
      const d = pad(cur.getDate());
      buckets.push(`${y}-${m}-${d}`);
      cur.setDate(cur.getDate() + 1);
    }
  } else if (unit === "hour") {
    const cur = new Date(s.getFullYear(), s.getMonth(), s.getDate(), s.getHours());
    while (cur <= e) {
      const y = cur.getFullYear();
      const m = pad(cur.getMonth() + 1);
      const d = pad(cur.getDate());
      const h = pad(cur.getHours());
      buckets.push(`${y}-${m}-${d}T${h}`);
      cur.setHours(cur.getHours() + 1);
    }
  }

  return buckets;
};

// Returns labels + series for CarIntake data (Scraped and Sold)
async function getDashboardSummary(query) {
  const { startDate: sDate, endDate: eDate, groupBy = "month" } = query;
  const bucketDef = buildDateBucket(groupBy);
  const dbFormat = bucketDef.format;
  const unit = bucketDef.unit;

  const now = new Date();
  let startDate = sDate ? new Date(sDate) : null;
  let endDate = eDate ? new Date(eDate) : null;
  if (!startDate || !endDate) {
    if (unit === "month") {
      startDate = new Date(now.getFullYear(), 0, 1);
      endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
    } else if (unit === "day") {
      endDate = endDate || now;
      startDate = startDate || new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
    } else if (unit === "hour") {
      endDate = endDate || now;
      startDate = startDate || new Date(now.getTime() - 23 * 60 * 60 * 1000);
    } else {
      endDate = endDate || now;
      startDate = startDate || new Date(now.getFullYear(), 0, 1);
    }
  }

  const match = { isActive: true, isDeleted: { $ne: true } };
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = startDate;
    if (endDate) match.createdAt.$lte = endDate;
  }

  const totalBucketsAgg = await carIntakeRepository.aggregate([
    { $match: match },
    {
      $group: {
        _id: { bucket: { $dateToString: { format: dbFormat, date: "$createdAt", timezone: "UTC" } } },
        count: { $sum: 1 },
      },
    },
    { $sort: { "_id.bucket": 1 } },
  ]);

  const scrapedMatch = { ...match, status: "scraped" };
  const scrapedBucketsAgg = await carIntakeRepository.aggregate([
    { $match: scrapedMatch },
    {
      $group: {
        _id: { bucket: { $dateToString: { format: dbFormat, date: "$createdAt", timezone: "UTC" } } },
        count: { $sum: 1 },
      },
    },
    { $sort: { "_id.bucket": 1 } },
  ]);

  const expectedBuckets = buildBuckets(unit, startDate, endDate);

  console.log("Dashboard Summary Debug:", {
    unit,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    expectedBucketsCount: expectedBuckets.length,
    expectedBuckets: expectedBuckets.slice(0, 5),
    totalRecords: totalBucketsAgg.length,
    scrapedRecords: scrapedBucketsAgg.length,
    totalBuckets: totalBucketsAgg.slice(0, 3),
    scrapedBuckets: scrapedBucketsAgg.slice(0, 3),
  });

  const seriesMap = { Total: {}, Scraped: {} };
  expectedBuckets.forEach((b) => {
    seriesMap.Total[b] = 0;
    seriesMap.Scraped[b] = 0;
  });

  totalBucketsAgg.forEach((b) => {
    seriesMap.Total[b._id.bucket] = b.count;
  });

  scrapedBucketsAgg.forEach((b) => {
    seriesMap.Scraped[b._id.bucket] = b.count;
  });

  const series = [
    { name: "Total Cars", data: expectedBuckets.map((l) => seriesMap.Total[l] || 0) },
    { name: "Scraped", data: expectedBuckets.map((l) => seriesMap.Scraped[l] || 0) },
  ];

  return { labels: expectedBuckets, series };
}

// Returns daily points and total for credit transactions (default last 30 days)
async function getRevenueTrend(query) {
  const { startDate: sDate, endDate: eDate } = query;
  const now = new Date();
  const endDate = eDate ? new Date(eDate) : now;
  const startDate = sDate ? new Date(sDate) : new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);

  const match = { isActive: true, type: "credit" };
  match.transactionDate = { $gte: startDate, $lte: endDate };

  const dailyAgg = await transactionRepository.aggregate([
    { $match: match },
    {
      $group: {
        _id: { date: { $dateToString: { format: "%Y-%m-%d", date: "$transactionDate", timezone: "UTC" } } },
        totalAmount: { $sum: { $ifNull: ["$amount", 0] } },
      },
    },
    { $sort: { "_id.date": 1 } },
  ]);

  const dayBuckets = buildBuckets("day", startDate, endDate);
  const dailyMap = {};
  dailyAgg.forEach((d) => {
    dailyMap[d._id.date] = d.totalAmount;
  });
  const daily = dayBuckets.map((d) => ({ date: d, totalAmount: dailyMap[d] || 0 }));
  const points = daily.map((d) => d.totalAmount || 0);
  const total = points.reduce((s, x) => s + (x || 0), 0);

  return { total, points, daily };
}

// Returns counts used by InfoCards: carIntakes, inventoryItems, scrapRecords
async function getSummaryCounts() {
  const carIntakes = await carIntakeRepository.countDocuments({ isActive: true, isDeleted: { $ne: true } });
  const inventoryItems = await inventoryRepository.countDocuments({ isDeleted: { $ne: true } });
  const scrapRecords = await carIntakeRepository.countDocuments({ status: "scraped" });

  let sellerCount = 0;
  try {
    sellerCount = await customerRepository.countDocuments({ type: "seller", isDeleted: { $ne: true } });
  } catch (e) {
    console.warn("Failed to count customers:", e);
    sellerCount = 0;
  }

  return { carIntakes, inventoryItems, scrapRecords, sellerCount };
}

// Returns totals for fromScrap and fromCheckIn
async function getEarningGoal(query) {
  const { startDate, endDate, scrapStatus = "scraped", goalAmount } = query;

  const baseMatch = { isDeleted: { $ne: true } };
  if (startDate || endDate) {
    baseMatch.createdAt = {};
    if (startDate) baseMatch.createdAt.$gte = new Date(startDate);
    if (endDate) baseMatch.createdAt.$lte = new Date(endDate);
  }

  const scrapMatch = Object.assign({}, baseMatch, { status: scrapStatus });
  const scrapAgg = await carIntakeRepository.aggregate([
    { $match: scrapMatch },
    { $group: { _id: null, total: { $sum: { $ifNull: ["$finalPrice", 0] } } } },
  ]);

  const checkInMatch = {};
  if (startDate || endDate) {
    checkInMatch.checkInTime = {};
    if (startDate) checkInMatch.checkInTime.$gte = new Date(startDate);
    if (endDate) checkInMatch.checkInTime.$lte = new Date(endDate);
  }

  const checkInAgg = await checkInRepository.aggregate([
    { $match: checkInMatch },
    {
      $lookup: {
        from: "transactions",
        localField: "transaction",
        foreignField: "_id",
        as: "transactionData",
      },
    },
    { $unwind: { path: "$transactionData", preserveNullAndEmptyArrays: true } },
    { $group: { _id: null, total: { $sum: { $ifNull: ["$transactionData.amount", 0] } } } },
  ]);

  const fromScrapAmount = scrapAgg[0]?.total || 0;
  const fromCheckInAmount = checkInAgg[0]?.total || 0;

  const goal = goalAmount ? parseFloat(goalAmount) : undefined;
  const fromScrapPct = goal ? Math.round((fromScrapAmount / goal) * 100) : 70;
  const fromCheckInPct = goal ? Math.round((fromCheckInAmount / goal) * 100) : 80;

  return {
    fromScrap: { amount: fromScrapAmount, percentageOfGoal: fromScrapPct },
    fromCheckIn: { amount: fromCheckInAmount, percentageOfGoal: fromCheckInPct },
    goal: goal || null,
  };
}

module.exports = {
  getDashboardSummary,
  getRevenueTrend,
  getSummaryCounts,
  getEarningGoal,
};
