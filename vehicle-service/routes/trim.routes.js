const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const { createTrim, getTrims, getTrimById, updateTrim, deleteTrim } = require("../controllers/trim.controller");

router.post("/", auth, createTrim);
router.get("/", auth, getTrims);
router.get("/:id", auth, getTrimById);
router.put("/:id", auth, updateTrim);
router.delete("/:id", auth, deleteTrim);

module.exports = router;
