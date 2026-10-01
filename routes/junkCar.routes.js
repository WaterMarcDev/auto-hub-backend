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
    patchJunkCar,
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

/**
 * @swagger
 * /api/junk-car/{id}:
 *   patch:
 *     summary: Partially update a junk car request
 *     description: >
 *       Updates only the fields sent in the body. Unknown or system-managed fields are rejected with 400.
 *       Changing status or paymentStatus records the caller as assignedTo (unless assignedTo is sent),
 *       and a completed + paid request is moved to Car Intake once.
 *     tags: [Junk Car]
 *     security:
 *       - bearerAuth: []
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
 *             minProperties: 1
 *             properties:
 *               name: { type: string }
 *               email: { type: string }
 *               phone: { type: string }
 *               year: { type: string, example: "2010" }
 *               make: { type: string }
 *               model: { type: string }
 *               engineOrVin: { type: string }
 *               condition: { type: string }
 *               message: { type: string }
 *               remark: { type: string }
 *               status: { type: string, enum: [pending, in progress, completed] }
 *               source: { type: string, example: instagram }
 *               paymentStatus: { type: string, enum: [Not Paid, Cash, Online] }
 *               assignedTo: { type: string, nullable: true, description: User id, or null to unassign }
 *     responses:
 *       200:
 *         description: Junk car request updated successfully
 *       400:
 *         description: Invalid id, empty body, unknown field or invalid value
 *       401:
 *         description: Missing or invalid token
 *       404:
 *         description: Junk car request not found
 */
router.patch("/:id", auth, patchJunkCar);

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