const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const { createJunkCar, getJunkCars, getJunkCarById, updateJunkCar, deleteJunkCar, moveToIntake } = require("../controllers/junkCar.controller");

router.post("/", createJunkCar);          // public — online form submissions
router.get("/", auth, getJunkCars);
router.get("/:id", auth, getJunkCarById);
router.put("/:id", auth, updateJunkCar);
router.patch("/:id/move-to-intake", auth, moveToIntake);
router.delete("/:id", auth, deleteJunkCar);

module.exports = router;
