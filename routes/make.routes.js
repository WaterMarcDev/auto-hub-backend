const express = require("express");
const router = express.Router();

const { auth } = require("../middleware/auth");

const {
  createMake,
  getAllMakes,
  getMakeById,
  updateMake,
  deleteMake,
} = require("../controllers/make.controller");

const { cacheMiddleware } = require("../middleware/cache");

router.post("/", auth, createMake);
router.get("/", auth, cacheMiddleware("master:make", 3600), getAllMakes);
router.get("/:id", auth, getMakeById);
router.put("/:id", auth, updateMake);
router.delete("/:id", auth, deleteMake);

module.exports = router;
