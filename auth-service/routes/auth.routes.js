const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const { register, login, getProfile, logout } = require("../controllers/auth.controller");
const { auth } = require("../middleware/auth.middleware");

const loginValidation = [
  body("email").isEmail().withMessage("Please provide a valid email").normalizeEmail(),
  body("password").notEmpty().withMessage("Password is required"),
];

router.post("/register", register);
router.post("/login", loginValidation, login);
router.get("/profile", auth, getProfile);
router.post("/logout", auth, logout);

module.exports = router;
