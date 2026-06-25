const express = require("express");
const router  = express.Router();
const multer  = require("multer");
const path    = require("path");
const { auth } = require("../middleware/auth.middleware");
const { handleInboundEmail, getEmails, markRead, getBackInStockRequests } = require("../controllers/email.controller");

// Multer for inbound email attachments (SendGrid multipart)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, "..", "uploads")),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

router.post("/inbound", upload.any(), handleInboundEmail);  // SendGrid webhook — public
router.get("/",         auth, getEmails);
router.patch("/:id/read", auth, markRead);
router.get("/back-in-stock", auth, getBackInStockRequests);

module.exports = router;
