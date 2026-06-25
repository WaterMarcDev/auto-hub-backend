const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const { createCarIntake, getCarIntakes, getCarIntake, updateCarIntake, deleteCarIntake, updateCarIntakeStatus, moveToReadyToScrap, moveToScrapped, getCarIntakeStats, printPaymentSlip } = require("../controllers/carIntake.controller");

router.get("/stats", auth, getCarIntakeStats);
router.post("/", auth, createCarIntake);
router.get("/", auth, getCarIntakes);
router.get("/:id", auth, getCarIntake);
router.get("/:id/print-payment", auth, printPaymentSlip);
router.put("/:id", auth, updateCarIntake);
router.patch("/:id/status", auth, updateCarIntakeStatus);
router.patch("/:id/ready-to-scrap", auth, moveToReadyToScrap);
router.patch("/:id/move-to-scrapped", auth, moveToScrapped);
router.delete("/:id", auth, deleteCarIntake);

module.exports = router;
