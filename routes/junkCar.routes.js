// by shiva
/**
 * @swagger
 * tags:
 *   name: Junk Car
 *   description: Junk Car Request APIs
 */
// end here

const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");    // added by shiva
const { automationBotAuth } = require("../middleware/automationBotAuth");  // added by shiva


const {
    createJunkCarRequest,
    createAutomationBotJunkCarRequest,  // added by shiva
    getAllJunkCars,
    updateJunkCarStatus,
    updateJunkCarPaymentStatus,
    updateJunkCarSource,
    assignJunkCarStaff,   // added by shiva
    updateJunkCarRemark,  // added by shiva
} = require("../controllers/junkCar.controller");

//Create request

// by shiva
/**
 * @swagger
 * /api/junk-car:
 *   post:
 *     summary: Create junk car request
 *     tags: [Junk Car]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               phone:
 *                 type: string
 *               email:
 *                 type: string
 *               year:
 *                 type: string
 *               make:
 *                 type: string
 *               model:
 *                 type: string
 *               engineOrVin:
 *                 type: string
 *     responses:
 *       201:
 *         description: Request created successfully
 */
//end here
router.post("/", createJunkCarRequest);

// Automation bot route by shiva
router.post("/automation-bot", automationBotAuth, createAutomationBotJunkCarRequest); // added by shiva

// by shiva
/**
 * @swagger
 * /api/junk-car:
 *   get:
 *     summary: Get all junk car requests
 *     tags: [Junk Car]
 *     responses:
 *       200:
 *         description: List fetched successfully
 */
//end here
router.get("/", getAllJunkCars);

// by shiva
/**
 * @swagger
 * /api/junk-car/{id}/status:
 *   patch:
 *     summary: Update junk car request status
 *     tags: [Junk Car]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status:
 *                 type: string
 *                 example: pending
 *     responses:
 *       200:
 *         description: Status updated successfully
 */
// end here

// Remark route: By shiva
router.patch("/:id/remark", auth, updateJunkCarRemark);

router.patch("/:id/status", auth, updateJunkCarStatus);

// Source route by shiva
router.patch("/:id/source", updateJunkCarSource);

// AssignJunkCarStaff route by shiva
router.patch("/:id/assign", assignJunkCarStaff);

// Junkcar paymentStatus by shiva route
router.patch("/:id/payment-status", auth, updateJunkCarPaymentStatus);


module.exports = router;