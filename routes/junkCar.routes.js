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
    saveJunkCarLead,
    saveAutomationBotJunkCarRequest,  // added by shiva
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
 *     summary: Create or progressively update a junk car lead
 *     description: >
 *       Without a lead ID this creates a lead (name, phone or email required) and returns its leadId.
 *       With a lead ID (body `leadId`, or `X-Lead-ID` header) it updates only the supplied fields
 *       of that lead. Updates through this route are only allowed while the lead is still pending,
 *       unpaid, not moved to Car Intake and less than 24 hours old; otherwise 409
 *       (staff use PATCH /api/junk-car/{id}).
 *     tags: [Junk Car]
 *     parameters:
 *       - in: header
 *         name: X-Lead-ID
 *         required: false
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               leadId: { type: string, description: Omit to create a new lead }
 *               name: { type: string }
 *               phone: { type: string }
 *               email: { type: string }
 *               year: { type: string, example: "2015" }
 *               make: { type: string }
 *               model: { type: string }
 *               engineOrVin: { type: string }
 *               vin: { type: string, description: Alias of engineOrVin }
 *               condition: { type: string }
 *               message: { type: string }
 *               location: { type: string }
 *     responses:
 *       201:
 *         description: Lead created (operation "created", leadId)
 *       200:
 *         description: Lead updated (operation "updated", leadId, data)
 *       400:
 *         description: Missing contact, invalid lead ID, no fields to update or invalid value
 *       404:
 *         description: Lead not found
 *       409:
 *         description: Lead can no longer be updated through this route
 */
router.post("/", saveJunkCarLead);

// Automation bot route by shiva
/**
 * @swagger
 * /api/junk-car/automation-bot:
 *   post:
 *     summary: Create or update a junk car request from the AI Chatbot (Automation Bot)
 *     description: >
 *       Without a lead ID this creates a junk car request attributed to the Automation Bot and returns its leadId.
 *       With a lead ID (body `leadId`, or `X-Lead-ID` header) it updates only the supplied fields of a lead the
 *       bot itself created, while it is still pending, unpaid and not moved to Car Intake; otherwise 404 / 409.
 *     tags: [Junk Car]
 *     parameters:
 *       - in: header
 *         name: x-automation-bot-key
 *         required: true
 *         schema:
 *           type: string
 *       - in: header
 *         name: X-Lead-ID
 *         required: false
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               leadId: { type: string, description: Omit to create a new lead }
 *               name: { type: string }
 *               email: { type: string }
 *               phone: { type: string }
 *               year: { type: string, example: "2015" }
 *               make: { type: string }
 *               model: { type: string }
 *               engineOrVin: { type: string }
 *               condition: { type: string }
 *               message: { type: string }
 *               location: { type: string }
 *               source: { type: string, example: instagram }
 *     responses:
 *       201:
 *         description: Request created, attributed to the Automation Bot user (operation "created", leadId)
 *       200:
 *         description: Lead updated (operation "updated", leadId, data)
 *       400:
 *         description: Invalid lead ID, no fields to update or invalid value
 *       401:
 *         description: Invalid or missing Automation Bot API key
 *       404:
 *         description: Lead not found (or not created by the Automation Bot)
 *       409:
 *         description: Lead is already being worked by staff
 */
router.post("/automation-bot", automationBotAuth, saveAutomationBotJunkCarRequest); // added by shiva

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
 *               location: { type: string }
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