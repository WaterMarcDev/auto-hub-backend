const express = require("express");
const router = express.Router();

const { auth } = require("../middleware/auth");

const {
  createElement,
  getAllElements,
  getElementById,
  updateElement,
} = require("../controllers/elements.controller");

router.post("/", auth, createElement);
router.get("/", auth, getAllElements);
router.get("/:id", auth, getElementById);
router.put("/:id", auth, updateElement);

module.exports = router;
