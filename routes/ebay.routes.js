const express = require("express");
const router = express.Router();

const {
  challenge,
  accountDeletion,
  notificationChallenge,
  notification,
} = require("../controllers/ebay.controller");

router.get("/account-deletion", challenge);

router.post("/account-deletion", accountDeletion);

// eBay Notification API: ORDER_CONFIRMATION webhooks (signature-verified)
router.get("/notifications", notificationChallenge);
router.post("/notifications", notification);

module.exports = router;