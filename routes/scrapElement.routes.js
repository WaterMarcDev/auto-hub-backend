const express = require("express");
const router = express.Router();
const { auth, permit } = require("../middleware/auth");
const {
  createScrapElement,
  getScrapElementsByVIN,
} = require("../controllers/scrapElement.controller");

// Create a new scrap element — adds Element Hub stock, so scraper/admin only.
// (The scrap workflow saves elements via /api/car-intake/:id/move-to-scrapped.)
router.post("/", auth, permit("scraper", "admin"), createScrapElement);

// Get scrap elements by VIN
router.get("/vin/:vin", auth, getScrapElementsByVIN);

module.exports = router;
