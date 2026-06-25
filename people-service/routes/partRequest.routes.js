const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const { createPartRequest, getPartRequests, getPartRequestById, updatePartRequest, deletePartRequest } = require("../controllers/partRequest.controller");

router.post("/",      createPartRequest);           // public — online form
router.get("/",       auth, getPartRequests);
router.get("/:id",    auth, getPartRequestById);
router.put("/:id",    auth, updatePartRequest);
router.delete("/:id", auth, deletePartRequest);

module.exports = router;
