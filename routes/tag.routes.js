const express = require("express");
const router = express.Router();
const controller = require("../controllers/tag.controller");

router.post("/generate", controller.generateTags);
router.get("/", controller.getAllTags);
router.get("/available", controller.getAvailableTags);
router.get("/:barcode", controller.getTag);
router.patch("/:barcode/toggle", controller.toggleTag);
// router.delete("/:barcode", controller.deleteTag);

module.exports = router;
