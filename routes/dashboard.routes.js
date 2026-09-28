// by shiva
/**
 * @swagger
 * tags:
 *   name: Dashboard
 *   description: Dashboard Analytics APIs
 */
//end here

const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const {
  getDashboardSummary,
  getRevenueTrend,
  getSummaryCounts,
  getEarningGoal,
} = require("../controllers/dashboard.controller");

// @route GET /api/dashboard/summary

// by shiva
/**
 * @swagger
 * /api/dashboard/summary:
 *   get:
 *     summary: Get dashboard summary
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard summary fetched successfully
 */
const { cacheMiddleware } = require("../middleware/cache");

router.get("/summary", auth, cacheMiddleware("dash:summary", 30), getDashboardSummary);
router.get("/revenue-trend", auth, cacheMiddleware("dash:trend", 30), getRevenueTrend);
router.get("/summary-counts", auth, cacheMiddleware("dash:counts", 30), getSummaryCounts);
router.get("/earning-goal", auth, cacheMiddleware("dash:goal", 30), getEarningGoal);

module.exports = router;
