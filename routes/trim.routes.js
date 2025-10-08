const express = require("express");
const router = express.Router();

const { auth } = require("../middleware/auth");

const {
  createTrim,
  getAllTrims,
  getTrimById,
  updateTrim,
  deleteTrim,
} = require("../controllers/trim.controller");

router.post("/", auth, createTrim);
router.get("/", auth, getAllTrims);
router.get("/:id", auth, getTrimById);
router.put("/:id", auth, updateTrim);
router.delete("/:id", auth, deleteTrim);

module.exports = router;
