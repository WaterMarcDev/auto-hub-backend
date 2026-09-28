const express = require("express");
const router = express.Router();
const {
  createScrapElement,
  getScrapElementsByVIN,
} = require("../controllers/scrapElement.controller");

// Create a new scrap element
router.post("/", createScrapElement);

// Get scrap elements by VIN
router.get("/vin/:vin", getScrapElementsByVIN);

module.exports = router;
