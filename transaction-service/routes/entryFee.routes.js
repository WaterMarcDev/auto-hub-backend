const express = require("express");
const router = express.Router();
const { auth, permit } = require("../middleware/auth.middleware");
const { getEntryFee, updateEntryFee } = require("../controllers/entryFee.controller");

router.get("/", auth, getEntryFee);
router.put("/", auth, permit("admin", "manager"), updateEntryFee);

module.exports = router;
