const express = require("express");
const {
  register,
  login,
  getProfile,
  logout,
} = require("../controllers/authController");
const {
  registerValidation,
  loginValidation,
} = require("../middleware/validation");
const { auth } = require("../middleware/auth");

const router = express.Router();

// @route   POST /api/auth/register
// @desc    Register a new user
// @access  Public
router.post("/register", registerValidation, register);

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post("/login", loginValidation, login);

// @route   GET /api/auth/profile
// @desc    Get user profile
// @access  Private
router.get("/profile", auth, getProfile);

// @route   POST /api/auth/logout
// @desc    Logout user
// @access  Private
router.post("/logout", auth, logout);

module.exports = router;
