const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const { createWaiver, getWaivers, getWaiverById, updateWaiver, deleteWaiver } = require("../controllers/waiver.controller");

router.post("/",      auth, createWaiver);
router.get("/",       auth, getWaivers);
router.get("/:id",    auth, getWaiverById);
router.put("/:id",    auth, updateWaiver);
router.delete("/:id", auth, deleteWaiver);

module.exports = router;
