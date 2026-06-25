const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const { generateTags, getTags, getTagById, assignTag, deleteTag } = require("../controllers/tag.controller");

router.post("/generate", auth, generateTags);
router.post("/", auth, generateTags);          // alias
router.get("/", auth, getTags);
router.get("/:id", auth, getTagById);
router.patch("/:id/assign", auth, assignTag);
router.delete("/:id", auth, deleteTag);

module.exports = router;
