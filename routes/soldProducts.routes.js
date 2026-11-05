const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const controller = require("../controllers/soldProducts.controller");

// Base path: /api/sold-products — parts sold on eBay / Wix.
router.get("/summary", auth, controller.summary);
router.post("/sync", auth, controller.syncNow);
router.get("/", auth, controller.list);
router.get("/:id", auth, controller.getOne);

module.exports = router;
