const express = require("express");
const router = express.Router();
const mobileAuthController = require("../controllers/mobileAuth.controller");
const { requireMobileAuth } = require("../middleware/mobileAuth.middleware");
const { mobileAuthLimiter, mobileApiLimiter } = require("../middleware/mobileRateLimiter");
const {
  registerValidation,
  loginValidation,
  refreshTokenValidation,
  updateProfileValidation,
} = require("../validations/mobileAuth.validation");

/**
 * Mobile Authentication Routes
 * Base URL: /api/v1/app/auth
 */

// @route   POST /api/v1/app/auth/register
// @desc    Register a new customer account
// @access  Public (Rate limited)
router.post(
  "/register",
  mobileAuthLimiter,
  registerValidation,
  mobileAuthController.register
);

// @route   POST /api/v1/app/auth/login
// @desc    Log in customer and return token pair + serialized profile
// @access  Public (Rate limited)
router.post(
  "/login",
  mobileAuthLimiter,
  loginValidation,
  mobileAuthController.login
);

// @route   POST /api/v1/app/auth/refresh-token
// @desc    Exchange refresh token for a new token pair
// @access  Public
router.post(
  "/refresh-token",
  refreshTokenValidation,
  mobileAuthController.refreshToken
);

// @route   GET /api/v1/app/auth/profile
// @desc    Get current authenticated user profile (Cached in memory)
// @access  Private (Bearer Token)
router.get(
  "/profile",
  mobileApiLimiter,
  requireMobileAuth,
  mobileAuthController.getProfile
);

// @route   PUT /api/v1/app/auth/profile
// @desc    Update profile fields (fullName, phone, location, avatarUrl, accountType)
// @access  Private (Bearer Token)
router.put(
  "/profile",
  mobileApiLimiter,
  requireMobileAuth,
  updateProfileValidation,
  mobileAuthController.updateProfile
);

// @route   PUT /api/v1/app/auth/settings
// @desc    Update notification and UI preference settings
// @access  Private (Bearer Token)
router.put(
  "/settings",
  mobileApiLimiter,
  requireMobileAuth,
  mobileAuthController.updateSettings
);

// @route   POST /api/v1/app/auth/logout
// @desc    Log out and revoke refresh token
// @access  Private (Bearer Token)
router.post(
  "/logout",
  requireMobileAuth,
  mobileAuthController.logout
);

module.exports = router;
