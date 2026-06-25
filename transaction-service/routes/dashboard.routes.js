const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const { getDashboardSummary, getRevenueTrend, getSummaryCounts, getEarningGoal } = require("../controllers/dashboard.controller");

router.get("/summary", auth, getDashboardSummary);
router.get("/revenue-trend", auth, getRevenueTrend);
router.get("/summary-counts", auth, getSummaryCounts);
router.get("/earning-goal", auth, getEarningGoal);

module.exports = router;
