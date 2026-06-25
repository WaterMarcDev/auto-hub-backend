const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const { createMake, getMakes, getMakeById, updateMake, deleteMake } = require("../controllers/make.controller");

router.post("/", auth, createMake);
router.get("/", auth, getMakes);
router.get("/:id", auth, getMakeById);
router.put("/:id", auth, updateMake);
router.delete("/:id", auth, deleteMake);

module.exports = router;
