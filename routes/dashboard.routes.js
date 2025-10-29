const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const {
  getDashboardSummary,
  getRevenueTrend,
  getSummaryCounts,
  getEarningGoal,
} = require("../controllers/dashboardController");

// @route GET /api/dashboard/summary
router.get("/summary", auth, getDashboardSummary);

// @route GET /api/dashboard/revenue-trend
router.get("/revenue-trend", auth, getRevenueTrend);

// @route GET /api/dashboard/summary-counts
router.get("/summary-counts", auth, getSummaryCounts);

// @route GET /api/dashboard/earning-goal
router.get("/earning-goal", auth, getEarningGoal);

module.exports = router;
