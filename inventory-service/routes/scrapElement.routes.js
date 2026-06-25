const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const { createScrapElement, getScrapElements, getScrapElementById, updateScrapElement, deleteScrapElement } = require("../controllers/scrapElement.controller");

router.post("/", auth, createScrapElement);
router.get("/", auth, getScrapElements);
router.get("/:id", auth, getScrapElementById);
router.put("/:id", auth, updateScrapElement);
router.delete("/:id", auth, deleteScrapElement);

module.exports = router;
