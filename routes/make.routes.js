const express = require("express");
const router = express.Router();

const { auth } = require("../middleware/auth");

const {
  createMake,
  getAllMakes,
  getMakeById,
  updateMake,
} = require("../controllers/make.controller");

router.post("/", auth, createMake);
router.get("/", auth, getAllMakes);
router.get("/:id", auth, getMakeById);
router.put("/:id", auth, updateMake);

module.exports = router;
