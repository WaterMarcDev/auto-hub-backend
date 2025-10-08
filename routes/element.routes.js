const express = require("express");
const router = express.Router();

const { auth } = require("../middleware/auth");

const {
  createElement,
  getAllElements,
  getElementById,
  updateElement,
  deleteElement,
} = require("../controllers/elements.controller");

router.post("/", auth, createElement);
router.get("/", auth, getAllElements);
router.get("/:id", auth, getElementById);
router.put("/:id", auth, updateElement);
router.delete("/:id", auth, deleteElement);

module.exports = router;
