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

const { cacheMiddleware } = require("../middleware/cache");

router.post("/", auth, createModel);
router.get("/", auth, cacheMiddleware("master:model", 3600), getAllModels);
router.get("/:id", auth, getModelById);
router.put("/:id", auth, updateModel);
router.delete("/:id", auth, deleteModel);

module.exports = router;
