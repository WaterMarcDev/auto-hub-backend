const express = require("express");
const router = express.Router();

const { auth } = require("../middleware/auth");

const {
  createModel,
  getAllModels,
  getModelById,
  updateModel,
  deleteModel,
} = require("../controllers/model.controller");

router.post("/", auth, createModel);
router.get("/", auth, getAllModels);
router.get("/:id", auth, getModelById);
router.put("/:id", auth, updateModel);
router.delete("/:id", auth, deleteModel);

module.exports = router;
