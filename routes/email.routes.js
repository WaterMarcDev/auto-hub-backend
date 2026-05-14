console.log("✅ Enter routes file loaded")

const express = require("express");
const router = express.Router();
// added by shiva
const multer = require("multer");
const path = require("path");   // added by shiva

// To store the Attachments so that we can preview it.
const storage = multer.diskStorage({

    destination: function (req, file, cb) {

        cb(
            null,
            "uploads/"
        );
    },

    filename: function (req, file, cb) {

        const uniqueName =
            Date.now() +
            "-" +
            file.originalname.replace(/\s+/g, "-");

        cb(
            null,
            uniqueName
        );
    }
});
// end here

const upload = multer({
    storage,
    limits: {
        fileSize: 20 * 1024 * 1024   //20MB size
    }
});    //update from const upload = multer() to ->
// end here

const { testCreateEmail, getEmails, handleInboundEmail } = require("../controllers/email.controller");
const CRMEmail = require("../models/CRMEmail.model");  //added by shiva
const { sendReply, forwardEmail } = require("../controllers/sendEmail.controller");    // add forwardEmail
// const emailController = require("../controllers/email.controller")

// TEMP route by shiva
router.get("/check", (req, res) => {
    res.send("EMAIL ROUTE WORKING");
});
// end here

router.post("/test-email", testCreateEmail);

// all emails
router.get("/all", getEmails);   //added by shiva

// inbound route
router.post("/inbound", upload.none(), handleInboundEmail);  //added upload.none() by shiva

// sendReply email route
router.post("/reply", upload.array("attachments"), sendReply);   // update with-> upload.array("attachments"),

// Forward Email Route by shiva
router.post(
  "/forward",
  upload.array("attachments"),
  forwardEmail
);
// end here

// routing for mark as read button by shiva
router.patch("/mark-read/:id", async (req, res) => {
  try {
    await CRMEmail.findByIdAndUpdate(req.params.id, {
      status: "read"
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update status" });
  }
});

// thread route
router.get("/thread/:id", async (req, res) => {
  try {
    // 1. Get clicked email
    const email = await CRMEmail.findById(req.params.id);

    if (!email) {
      return res.status(404).json({ error: "Email not found" });
    }

    // 2. Fetch only SAME thread_id
    const thread = await CRMEmail.find({
      thread_id: email.thread_id
    }).sort({ created_at: 1 });

    res.json(thread);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch thread" });
  }
});


module.exports = router;