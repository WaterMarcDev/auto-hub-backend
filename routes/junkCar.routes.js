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

const {
    createJunkCarRequest,
    getAllJunkCars,
    updateJunkCarStatus,
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
router.patch("/:id/status", updateJunkCarStatus);

module.exports = router;