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
} = require("../controllers/dashboardController");

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
//end here
router.get("/summary", auth, getDashboardSummary);

// @route GET /api/dashboard/revenue-trend

// by shiva
/**
 * @swagger
 * /api/dashboard/revenue-trend:
 *   get:
 *     summary: Get revenue trend analytics
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Revenue trend fetched successfully
 */
//end here
router.get("/revenue-trend", auth, getRevenueTrend);

// @route GET /api/dashboard/summary-counts

// by shiva
/**
 * @swagger
 * /api/dashboard/summary-counts:
 *   get:
 *     summary: Get summary counts
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Summary counts fetched successfully
 */
//end here
router.get("/summary-counts", auth, getSummaryCounts);

// @route GET /api/dashboard/earning-goal

// by shiva
/**
 * @swagger
 * /api/dashboard/earning-goal:
 *   get:
 *     summary: Get earning goal progress
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Earning goal fetched successfully
 */
//end here
router.get("/earning-goal", auth, getEarningGoal);

module.exports = router;
