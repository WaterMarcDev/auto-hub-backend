console.log("Junk Request Routes Loaded");

const express = require("express");
const router = express.Router();

const {
    createRequest,
    getAllRequests,
    updateStatus
} = require("../controllers/junkPartRequestController");

// const JunkPartRequest = require("../models/JunkPartRequest");

router.get("/test", (req, res) => {
    res.send("Junk route working");
});

router.post("/", createRequest);
router.get("/", getAllRequests);
router.put("/:id", updateStatus);

module.exports = router;