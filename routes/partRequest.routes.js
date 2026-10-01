console.log("Part Request Routes Loaded");

// by shiva
/**
 * @swagger
 * tags:
 *   name: Part Requests
 *   description: Customer Part Request APIs
 */
// end here

const express = require("express");
const router = express.Router();
const { automationBotAuth } = require("../middleware/automationBotAuth");
const { auth } = require("../middleware/auth");

const { deleteRequest } = require("../controllers/partRequest.controller");

const {
    savePartRequestLead,
    getAllRequests,
    updateStatus,
    updatePartRequestSource,
    updatePartRequestRemark,
    saveAutomationBotRequest,
    patchPartRequest,
} = require("../controllers/partRequest.controller");

// const PartRequest = require("../models/PartRequest");

// by shiva
/**
 * @swagger
 * /api/part-request/test:
 *   get:
 *     summary: Test part request route
 *     tags: [Part Requests]
 *     responses:
 *       200:
 *         description: Route working
 */
//end here
router.get("/test", (req, res) => {
    res.send("Part route working");
});

// by shiva
/**
 * @swagger
 * /api/part-request:
 *   post:
 *     summary: Create or progressively update a Search Part (part request) lead
 *     description: >
 *       Without a lead ID this creates a lead (phone or email required) and returns its leadId.
 *       With a lead ID (body `leadId`, or `X-Lead-ID` header) it updates only the supplied fields
 *       of that lead. Updates through this route are only allowed while the lead is still Pending
 *       and less than 24 hours old; otherwise 409 (staff use PATCH /api/part-request/{id}).
 *     tags: [Part Requests]
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
 *               phone: { type: string, example: "5551234567" }
 *               email: { type: string }
 *               make: { type: string }
 *               model: { type: string }
 *               year: { type: string, example: "2020" }
 *               partName: { type: string }
 *               condition: { type: string }
 *               message: { type: string }
 *               source: { type: string, example: Website }
 *               status: { type: string, enum: [Pending, In Progress, Completed, Rejected] }
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
router.post("/", savePartRequestLead);

// by shiva
/**
 * @swagger
 * /api/part-request:
 *   get:
 *     summary: Get all part requests
 *     tags: [Part Requests]
 *     responses:
 *       200:
 *         description: Requests fetched successfully
 */
// end here
router.get("/", getAllRequests);

// by shiva
/**
 * @swagger
 * /api/part-request/{id}:
 *   put:
 *     summary: Update request status
 *     tags: [Part Requests]
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
 *     responses:
 *       200:
 *         description: Status updated successfully
 */
// end here
router.put("/:id", updateStatus);

// by shiva
/**
 * @swagger
 * /api/part-request/{id}:
 *   delete:
 *     summary: Delete part request
 *     tags: [Part Requests]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Request deleted successfully
 */
//end here
router.delete("/:id", deleteRequest);

/**
 * @swagger
 * /api/part-request/{id}:
 *   patch:
 *     summary: Partially update a Search Part (part request)
 *     description: Updates only the fields sent in the body. Unknown or system-managed fields are rejected with 400.
 *     tags: [Part Requests]
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
 *               phone: { type: string, example: "5551234567" }
 *               email: { type: string }
 *               make: { type: string }
 *               model: { type: string }
 *               year: { type: string, example: "2015" }
 *               partName: { type: string }
 *               condition: { type: string }
 *               message: { type: string }
 *               remark: { type: string }
 *               source: { type: string, example: Instagram }
 *               status: { type: string, enum: [Pending, In Progress, Completed, Rejected] }
 *               fulfilledBy: { type: string }
 *     responses:
 *       200:
 *         description: Part request updated successfully
 *       400:
 *         description: Invalid id, empty body, unknown field or invalid value
 *       401:
 *         description: Missing or invalid token
 *       404:
 *         description: Part request not found
 */
router.patch("/:id", auth, patchPartRequest);

// Source route by shiva
router.patch("/:id/source", updatePartRequestSource);

// Remark route by shiva
router.patch("/:id/remark", (req, res, next) => {

    console.log("REMARK ROUTE HIT");

    next();

}, updatePartRequestRemark);

/**
 * @swagger
 * /api/part-request/automation-bot:
 *   post:
 *     summary: Create or update a part request from the AI Chatbot (Automation Bot)
 *     description: >
 *       Without a lead ID this creates a part request attributed to the Automation Bot and returns its leadId.
 *       With a lead ID (body `leadId`, or `X-Lead-ID` header) it updates only the supplied fields of a
 *       lead the bot itself created, while it is still Pending; otherwise 404 / 409.
 *     tags: [Part Requests]
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
 *               leadId:
 *                 type: string
 *                 description: Omit to create a new lead
 *               name:
 *                 type: string
 *               phone:
 *                 type: string
 *               email:
 *                 type: string
 *               make:
 *                 type: string
 *               model:
 *                 type: string
 *               year:
 *                 type: string
 *               partName:
 *                 type: string
 *               source:
 *                 type: string
 *                 example: WhatsApp
 *     responses:
 *       201:
 *         description: Request created successfully, attributed to the Automation Bot user (operation "created", leadId)
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
router.post("/automation-bot", automationBotAuth, saveAutomationBotRequest);

module.exports = router;