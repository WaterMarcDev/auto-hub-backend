const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const { createPart, getParts, getPartById, updatePart, deletePart } = require("../controllers/part.controller");

router.post("/", auth, createPart);
router.get("/", auth, getParts);
router.get("/:id", auth, getPartById);
router.put("/:id", auth, updatePart);
router.delete("/:id", auth, deletePart);

module.exports = router;
