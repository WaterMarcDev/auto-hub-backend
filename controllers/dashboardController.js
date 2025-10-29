const Transaction = require("../models/Transaction");
const CarIntake = require("../models/carInTake.model");
const Inventory = require("../models/Inventory.model");
const Waiver = require("../models/Waiver.model");
const Customer = require("../models/customer");

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
    const cur = new Date(
      s.getFullYear(),
      s.getMonth(),
      s.getDate(),
      s.getHours()
    );
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

// GET /api/dashboard/summary
// Returns labels + series for Earning (credit) and Paid (debit)
const getDashboardSummary = async (req, res) => {
  try {
    const { startDate: sDate, endDate: eDate, groupBy = "month" } = req.query;
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
        startDate =
          startDate || new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
      } else if (unit === "hour") {
        endDate = endDate || now;
        startDate = startDate || new Date(now.getTime() - 23 * 60 * 60 * 1000);
      } else {
        endDate = endDate || now;
        startDate = startDate || new Date(now.getFullYear(), 0, 1);
      }
    }

    const match = { isActive: true };
    if (startDate || endDate) {
      match.transactionDate = {};
      if (startDate) match.transactionDate.$gte = startDate;
      if (endDate) match.transactionDate.$lte = endDate;
    }

    // Aggregate transactions by time bucket and type
    const bucketsAgg = await Transaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            bucket: {
              $dateToString: { format: dbFormat, date: "$transactionDate" },
            },
            type: "$type",
          },
          totalAmount: { $sum: { $ifNull: ["$amount", 0] } },
        },
      },
      { $sort: { "_id.bucket": 1 } },
    ]);

    const expectedBuckets = buildBuckets(unit, startDate, endDate);

    const seriesMap = { Earning: {}, Paid: {} };
    expectedBuckets.forEach((b) => {
      seriesMap.Earning[b] = 0;
      seriesMap.Paid[b] = 0;
    });

    bucketsAgg.forEach((b) => {
      const bucket = b._id.bucket;
      const t = b._id.type;
      if (t === "credit") seriesMap.Earning[bucket] = b.totalAmount;
      else if (t === "debit") seriesMap.Paid[bucket] = b.totalAmount;
    });

    const series = [
      {
        name: "Earning",
        data: expectedBuckets.map((l) => seriesMap.Earning[l] || 0),
      },
      {
        name: "Paid",
        data: expectedBuckets.map((l) => seriesMap.Paid[l] || 0),
      },
    ];

    return res.json({ labels: expectedBuckets, series });
  } catch (error) {
    console.error("getDashboardSummary error:", error);
    return res.status(500).json({ error: "Server error" });
  }
};

// GET /api/dashboard/revenue-trend
// Returns daily points and total for the requested date range (default last 30 days)
const getRevenueTrend = async (req, res) => {
  try {
    const { startDate: sDate, endDate: eDate } = req.query;
    const now = new Date();
    const endDate = eDate ? new Date(eDate) : now;
    const startDate = sDate
      ? new Date(sDate)
      : new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);

    const match = { isActive: true };
    match.transactionDate = { $gte: startDate, $lte: endDate };

    const dailyAgg = await Transaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            date: {
              $dateToString: { format: "%Y-%m-%d", date: "$transactionDate" },
            },
          },
          totalAmount: { $sum: { $ifNull: ["$amount", 0] } },
        },
      },
      { $sort: { "_id.date": 1 } },
    ]);

    // build expected days
    const dayBuckets = buildBuckets("day", startDate, endDate);
    const dailyMap = {};
    dailyAgg.forEach((d) => {
      dailyMap[d._id.date] = d.totalAmount;
    });
    const daily = dayBuckets.map((d) => ({
      date: d,
      totalAmount: dailyMap[d] || 0,
    }));
    const points = daily.map((d) => d.totalAmount || 0);
    const total = points.reduce((s, x) => s + (x || 0), 0);
    return res.json({ total, points, daily });
  } catch (error) {
    console.error("getRevenueTrend error:", error);
    return res.status(500).json({ error: "Server error" });
  }
};

// GET /api/dashboard/summary-counts
// Returns counts used by InfoCards: carIntakes, inventoryItems, scrapRecords
const getSummaryCounts = async (req, res) => {
  try {
    const carIntakes = await CarIntake.countDocuments({
      isActive: true,
      isDeleted: { $ne: true },
    });
    const inventoryItems = await Inventory.countDocuments({
      isDeleted: { $ne: true },
    });
    // scrapRecords: count of car intakes with status 'scraped'
    const scrapRecords = await CarIntake.countDocuments({ status: "scraped" });

    // seller count comes from Customer model where type === 'seller'
    let sellerCount = 0;
    try {
      sellerCount = await Customer.countDocuments({
        type: "seller",
        isDeleted: { $ne: true },
      });
    } catch (e) {
      console.warn("Failed to count customers:", e);
      sellerCount = 0;
    }

    return res.json({ carIntakes, inventoryItems, scrapRecords, sellerCount });
  } catch (error) {
    console.error("getSummaryCounts error:", error);
    return res.status(500).json({ error: "Server error" });
  }
};

// GET /api/dashboard/earning-goal
// Returns totals for fromScrap and fromJunk (configurable statuses via query)
const getEarningGoal = async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      scrapStatus = "scraped",
      junkStatus = "sold",
      goalAmount,
    } = req.query;

    const baseMatch = { isDeleted: { $ne: true } };
    if (startDate || endDate) {
      baseMatch.createdAt = {};
      if (startDate) baseMatch.createdAt.$gte = new Date(startDate);
      if (endDate) baseMatch.createdAt.$lte = new Date(endDate);
    }

    const scrapMatch = Object.assign({}, baseMatch, { status: scrapStatus });
    const junkMatch = Object.assign({}, baseMatch, { status: junkStatus });

    const scrapAgg = await CarIntake.aggregate([
      { $match: scrapMatch },
      {
        $group: { _id: null, total: { $sum: { $ifNull: ["$finalPrice", 0] } } },
      },
    ]);
    const junkAgg = await CarIntake.aggregate([
      { $match: junkMatch },
      {
        $group: { _id: null, total: { $sum: { $ifNull: ["$finalPrice", 0] } } },
      },
    ]);

    const fromScrapAmount = scrapAgg[0]?.total || 0;
    const fromJunkAmount = junkAgg[0]?.total || 0;

    const goal = goalAmount ? parseFloat(goalAmount) : undefined;
    const fromScrapPct = goal
      ? Math.round((fromScrapAmount / goal) * 100)
      : null;
    const fromJunkPct = goal ? Math.round((fromJunkAmount / goal) * 100) : null;

    return res.json({
      fromScrap: { amount: fromScrapAmount, percentageOfGoal: fromScrapPct },
      fromJunk: { amount: fromJunkAmount, percentageOfGoal: fromJunkPct },
      goal: goal || null,
    });
  } catch (error) {
    console.error("getEarningGoal error:", error);
    return res.status(500).json({ error: "Server error" });
  }
};

module.exports = {
  getDashboardSummary,
  getRevenueTrend,
  getSummaryCounts,
  getEarningGoal,
};
