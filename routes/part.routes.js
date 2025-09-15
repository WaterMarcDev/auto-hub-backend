const express = require("express");
const router = express.Router();

const { auth } = require("../middleware/auth");

const {
  createPart,
  getAllParts,
  getPartById,
  updatePart,
} = require("../controllers/part.controller");

router.post("/", auth, createPart);
router.get("/", auth, getAllParts);
router.get("/:id", auth, getPartById);
router.put("/:id", auth, updatePart);

module.exports = router;
