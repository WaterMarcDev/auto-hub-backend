const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const { createSeller, getSellers, getSeller, updateSeller, deleteSeller, searchSellers } = require("../controllers/seller.controller");

router.get("/search", auth, searchSellers);
router.post("/",     auth, createSeller);
router.get("/",      auth, getSellers);
router.get("/:id",   auth, getSeller);
router.put("/:id",   auth, updateSeller);
router.delete("/:id",auth, deleteSeller);

module.exports = router;
