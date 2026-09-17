const dashboardService = require("../services/dashboard.service");

// GET /api/dashboard/summary
// Returns labels + series for CarIntake data (Scraped and Sold)
const getDashboardSummary = async (req, res) => {
  try {
    const result = await dashboardService.getDashboardSummary(req.query);
    return res.json(result);
  } catch (error) {
    console.error("getDashboardSummary error:", error);
    return res.status(500).json({ error: "Server error" });
  }
};

// GET /api/dashboard/revenue-trend
// Returns daily points and total for credit transactions (default last 30 days)
const getRevenueTrend = async (req, res) => {
  try {
    const result = await dashboardService.getRevenueTrend(req.query);
    return res.json(result);
  } catch (error) {
    console.error("getRevenueTrend error:", error);
    return res.status(500).json({ error: "Server error" });
  }
};

// GET /api/dashboard/summary-counts
// Returns counts used by InfoCards: carIntakes, inventoryItems, scrapRecords
const getSummaryCounts = async (req, res) => {
  try {
    const result = await dashboardService.getSummaryCounts();
    return res.json(result);
  } catch (error) {
    console.error("getSummaryCounts error:", error);
    return res.status(500).json({ error: "Server error" });
  }
};

// GET /api/dashboard/earning-goal
// Returns totals for fromScrap and fromCheckIn
const getEarningGoal = async (req, res) => {
  try {
    const result = await dashboardService.getEarningGoal(req.query);
    return res.json(result);
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
