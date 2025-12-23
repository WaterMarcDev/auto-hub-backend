const express = require("express");
const router = express.Router();
const controller = require("../controllers/tag.controller");

router.get("/", controller.getAllTags);
router.post("/generate", controller.generateTags);
router.get("/available", controller.getAvailableTags);
router.get("/:barcode", controller.getTag);
router.delete("/:barcode", controller.deleteTag);
router.patch("/:barcode/toggle", controller.toggleTag);


module.exports = router;
