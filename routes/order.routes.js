const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const controller = require("../controllers/order.controller");

// GET /api/orders
router.get("/", auth, controller.getAll);

// GET /api/orders/:id
router.get("/:id", auth, controller.getById);

// PATCH /api/orders/:id/status
router.patch("/:id/status", auth, controller.updateStatus);

module.exports = router;
