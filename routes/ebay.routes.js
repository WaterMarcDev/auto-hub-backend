const express = require("express");
const router = express.Router();

const {
  challenge,
  accountDeletion,
} = require("../controllers/ebay.controller");

router.get("/account-deletion", challenge);

router.post("/account-deletion", accountDeletion);

module.exports = router;