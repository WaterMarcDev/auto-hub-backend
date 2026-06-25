const Transaction = require("../models/Transaction.model");
const CarIntake = require("../models/CarIntake.model");
const CheckIn = require("../models/CheckIn.model");

const pad = (n) => (n < 10 ? `0${n}` : `${n}`);

const buildBuckets = (unit, startDate, endDate) => {
  const buckets = [];
  const s = new Date(startDate);
  const e = new Date(endDate);
  if (unit === "month") {
    let y = s.getFullYear(), m = s.getMonth();
    while (y < e.getFullYear() || (y === e.getFullYear() && m <= e.getMonth())) {
      buckets.push(`${y}-${pad(m + 1)}`);
      if (++m > 11) { m = 0; y++; }
    }
  } else if (unit === "day") {
    const cur = new Date(s.getFullYear(), s.getMonth(), s.getDate());
    while (cur <= e) {
      buckets.push(`${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`);
      cur.setDate(cur.getDate() + 1);
    }
  } else if (unit === "hour") {
    const cur = new Date(s.getFullYear(), s.getMonth(), s.getDate(), s.getHours());
    while (cur <= e) {
      buckets.push(`${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}T${pad(cur.getHours())}`);
      cur.setHours(cur.getHours() + 1);
    }
  }
  return buckets;
};

const buildDateBucket = (groupBy) => {
  switch (groupBy) {
    case "hour":  return { format: "%Y-%m-%dT%H", unit: "hour" };
    case "day":   return { format: "%Y-%m-%d",    unit: "day" };
    default:      return { format: "%Y-%m",        unit: "month" };
  }
};

const defaultRange = (unit) => {
  const now = new Date();
  if (unit === "month") return { start: new Date(now.getFullYear(), 0, 1), end: new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999) };
  if (unit === "hour")  return { start: new Date(now.getTime() - 23 * 3600000), end: now };
  return { start: new Date(now.getTime() - 29 * 86400000), end: now };
};

// GET /api/dashboard/summary
const getDashboardSummary = async (req, res) => {
  try {
    const { startDate: sDate, endDate: eDate, groupBy = "month" } = req.query;
    const { format, unit } = buildDateBucket(groupBy);
    const def = defaultRange(unit);
    const startDate = sDate ? new Date(sDate) : def.start;
    const endDate   = eDate ? new Date(eDate) : def.end;

    const match = { isActive: true, isDeleted: { $ne: true }, createdAt: { $gte: startDate, $lte: endDate } };

    const bucket = { $dateToString: { format, date: "$createdAt", timezone: "UTC" } };

    const [totalAgg, scrapedAgg] = await Promise.all([
      CarIntake.aggregate([{ $match: match }, { $group: { _id: { bucket }, count: { $sum: 1 } } }, { $sort: { "_id.bucket": 1 } }]),
      CarIntake.aggregate([{ $match: { ...match, status: "scraped" } }, { $group: { _id: { bucket }, count: { $sum: 1 } } }, { $sort: { "_id.bucket": 1 } }]),
    ]);

    const expected = buildBuckets(unit, startDate, endDate);
    const totalMap = {}, scrapedMap = {};
    totalAgg.forEach(b => { totalMap[b._id.bucket] = b.count; });
    scrapedAgg.forEach(b => { scrapedMap[b._id.bucket] = b.count; });

    res.json({
      labels: expected,
      series: [
        { name: "Total Cars",  data: expected.map(l => totalMap[l]   || 0) },
        { name: "Scraped",     data: expected.map(l => scrapedMap[l] || 0) },
      ],
    });
  } catch (error) {
    console.error("getDashboardSummary error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/dashboard/revenue-trend
const getRevenueTrend = async (req, res) => {
  try {
    const now = new Date();
    const endDate   = req.query.endDate   ? new Date(req.query.endDate)   : now;
    const startDate = req.query.startDate ? new Date(req.query.startDate) : new Date(now.getTime() - 29 * 86400000);

    const dailyAgg = await Transaction.aggregate([
      { $match: { isActive: true, type: "credit", transactionDate: { $gte: startDate, $lte: endDate } } },
      { $group: { _id: { date: { $dateToString: { format: "%Y-%m-%d", date: "$transactionDate", timezone: "UTC" } } }, totalAmount: { $sum: { $ifNull: ["$amount", 0] } } } },
      { $sort: { "_id.date": 1 } },
    ]);

    const dayBuckets = buildBuckets("day", startDate, endDate);
    const dailyMap = {};
    dailyAgg.forEach(d => { dailyMap[d._id.date] = d.totalAmount; });
    const points = dayBuckets.map(d => dailyMap[d] || 0);
    const total  = points.reduce((s, x) => s + x, 0);

    res.json({ total, points, daily: dayBuckets.map(d => ({ date: d, totalAmount: dailyMap[d] || 0 })) });
  } catch (error) {
    console.error("getRevenueTrend error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/dashboard/summary-counts
const getSummaryCounts = async (req, res) => {
  try {
    const [carIntakes, scrapRecords] = await Promise.all([
      CarIntake.countDocuments({ isActive: true, isDeleted: { $ne: true } }),
      CarIntake.countDocuments({ status: "scraped" }),
    ]);
    // inventoryItems & sellerCount delegated to their own services; return what we have
    res.json({ carIntakes, scrapRecords });
  } catch (error) {
    console.error("getSummaryCounts error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/dashboard/earning-goal
const getEarningGoal = async (req, res) => {
  try {
    const { startDate, endDate, scrapStatus = "scraped", goalAmount } = req.query;

    const baseMatch = { isDeleted: { $ne: true } };
    if (startDate || endDate) {
      baseMatch.createdAt = {};
      if (startDate) baseMatch.createdAt.$gte = new Date(startDate);
      if (endDate)   baseMatch.createdAt.$lte = new Date(endDate);
    }

    const checkInMatch = {};
    if (startDate || endDate) {
      checkInMatch.checkInTime = {};
      if (startDate) checkInMatch.checkInTime.$gte = new Date(startDate);
      if (endDate)   checkInMatch.checkInTime.$lte = new Date(endDate);
    }

    const [scrapAgg, checkInAgg] = await Promise.all([
      CarIntake.aggregate([{ $match: { ...baseMatch, status: scrapStatus } }, { $group: { _id: null, total: { $sum: { $ifNull: ["$price.finalPrice", 0] } } } }]),
      CheckIn.aggregate([
        { $match: checkInMatch },
        { $lookup: { from: "transactions", localField: "transaction", foreignField: "_id", as: "txData" } },
        { $unwind: { path: "$txData", preserveNullAndEmptyArrays: true } },
        { $group: { _id: null, total: { $sum: { $ifNull: ["$txData.amount", 0] } } } },
      ]),
    ]);

    const fromScrap    = scrapAgg[0]?.total    || 0;
    const fromCheckIn  = checkInAgg[0]?.total  || 0;
    const goal         = goalAmount ? parseFloat(goalAmount) : null;

    res.json({
      fromScrap:   { amount: fromScrap,   percentageOfGoal: goal ? Math.round((fromScrap / goal) * 100) : 70 },
      fromCheckIn: { amount: fromCheckIn, percentageOfGoal: goal ? Math.round((fromCheckIn / goal) * 100) : 80 },
      goal,
    });
  } catch (error) {
    console.error("getEarningGoal error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = { getDashboardSummary, getRevenueTrend, getSummaryCounts, getEarningGoal };
