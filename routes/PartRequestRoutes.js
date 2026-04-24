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

const { deleteRequest } = require("../controllers/PartRequestController");

const {
    createRequest,
    getAllRequests,
    updateStatus
} = require("../controllers/PartRequestController");

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
 *     summary: Create part request
 *     tags: [Part Requests]
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
 *               make:
 *                 type: string
 *               model:
 *                 type: string
 *               year:
 *                 type: string
 *               partName:
 *                 type: string
 *     responses:
 *       201:
 *         description: Request created successfully
 */
//end here
router.post("/", createRequest);

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

module.exports = router;