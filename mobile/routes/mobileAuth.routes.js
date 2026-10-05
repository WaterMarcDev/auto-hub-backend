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
 * @swagger
 * tags:
 *   name: Mobile App - Auth
 *   description: End-user mobile customer authentication, token management, and profile APIs
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     MobileUserSettings:
 *       type: object
 *       properties:
 *         pushNotifications:
 *           type: boolean
 *           example: true
 *         emailNotifications:
 *           type: boolean
 *           example: true
 *         priceDropAlerts:
 *           type: boolean
 *           example: false
 *         orderUpdates:
 *           type: boolean
 *           example: true
 *         chatMessages:
 *           type: boolean
 *           example: true
 *         notificationSounds:
 *           type: boolean
 *           example: true
 *         vibration:
 *           type: boolean
 *           example: true
 *         darkMode:
 *           type: boolean
 *           example: true
 *         autoDistanceUnit:
 *           type: boolean
 *           example: true
 *         selectedLanguage:
 *           type: string
 *           example: "English"
 *         selectedLanguageFlag:
 *           type: string
 *           example: "🇺🇸"
 *     MobileDefaultAddress:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           example: "adr_1"
 *         streetAddress:
 *           type: string
 *           example: "4521 Westheimer Rd"
 *         city:
 *           type: string
 *           example: "Houston"
 *         state:
 *           type: string
 *           example: "TX"
 *         zip:
 *           type: string
 *           example: "77027"
 *     MobileDefaultPaymentMethod:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           example: "pm_1"
 *         brand:
 *           type: string
 *           example: "Visa"
 *         last4:
 *           type: string
 *           example: "4291"
 *         expiry:
 *           type: string
 *           example: "09/28"
 *     MobileUserStats:
 *       type: object
 *       properties:
 *         activeOrders:
 *           type: integer
 *           example: 1
 *         savedPartsCount:
 *           type: integer
 *           example: 5
 *         junkRequestsCount:
 *           type: integer
 *           example: 2
 *         completedOrders:
 *           type: integer
 *           example: 8
 *     MobileAppUserProfile:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           example: "usr_1"
 *         fullName:
 *           type: string
 *           example: "Mike Johnson"
 *         email:
 *           type: string
 *           example: "mike@x.com"
 *         phone:
 *           type: string
 *           example: "+1 609 758 1919"
 *         location:
 *           type: string
 *           example: "Houston, TX"
 *         avatarUrl:
 *           type: string
 *           example: "https://cdn.autohub.express/avatars/usr_1.jpg"
 *         memberSince:
 *           type: string
 *           example: "Mar 2024"
 *         accountType:
 *           type: string
 *           enum: [buyer, seller, both]
 *           example: "buyer"
 *         isVerified:
 *           type: boolean
 *           example: true
 *         status:
 *           type: string
 *           enum: [active, suspended, deleted]
 *           example: "active"
 *         settings:
 *           $ref: '#/components/schemas/MobileUserSettings'
 *         defaultAddress:
 *           $ref: '#/components/schemas/MobileDefaultAddress'
 *         defaultPaymentMethod:
 *           $ref: '#/components/schemas/MobileDefaultPaymentMethod'
 *         stats:
 *           $ref: '#/components/schemas/MobileUserStats'
 *     MobileAuthTokens:
 *       type: object
 *       properties:
 *         accessToken:
 *           type: string
 *           example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1c3JfMSIsImFjY291bnRUeXBlIjoiYnV5ZXIiLCJpYXQiOjE3MTIwMDAwMDAsImV4cCI6MTcxMjAwMzYwMH0.signature"
 *         refreshToken:
 *           type: string
 *           example: "7c9b83b9c6a04e3b97b0a88062de3cfa88b6038d172e2cf1758f8b030b621e25"
 *         expiresIn:
 *           type: integer
 *           example: 3600
 */

/**
 * @swagger
 * /api/v1/app/auth/register:
 *   post:
 *     summary: Register a new mobile customer account
 *     tags: [Mobile App - Auth]
 *     description: Creates a new customer account, issues a JWT token pair (1-hour access + 30-day rotated refresh), and initializes default user settings.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *               - fullName
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "mike@x.com"
 *               password:
 *                 type: string
 *                 format: password
 *                 minLength: 6
 *                 example: "Password123!"
 *               fullName:
 *                 type: string
 *                 example: "Mike Johnson"
 *               phone:
 *                 type: string
 *                 example: "+1 609 758 1919"
 *               location:
 *                 type: string
 *                 example: "Houston, TX"
 *               accountType:
 *                 type: string
 *                 enum: [buyer, seller, both]
 *                 example: "buyer"
 *     responses:
 *       201:
 *         description: Account successfully registered
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "Account registered successfully"
 *               tokens:
 *                 accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1c3JfMSIsImFjY291bnRUeXBlIjoiYnV5ZXIiLCJpYXQiOjE3MTIwMDAwMDAsImV4cCI6MTcxMjAwMzYwMH0.signature"
 *                 refreshToken: "7c9b83b9c6a04e3b97b0a88062de3cfa88b6038d172e2cf1758f8b030b621e25"
 *                 expiresIn: 3600
 *               user:
 *                 id: "usr_1"
 *                 fullName: "Mike Johnson"
 *                 email: "mike@x.com"
 *                 phone: "+1 609 758 1919"
 *                 location: "Houston, TX"
 *                 avatarUrl: "https://cdn.autohub.express/avatars/usr_1.jpg"
 *                 memberSince: "Mar 2024"
 *                 accountType: "buyer"
 *                 isVerified: true
 *                 status: "active"
 *                 settings:
 *                   pushNotifications: true
 *                   emailNotifications: true
 *                   priceDropAlerts: false
 *                   orderUpdates: true
 *                   chatMessages: true
 *                   notificationSounds: true
 *                   vibration: true
 *                   darkMode: true
 *                   autoDistanceUnit: true
 *                   selectedLanguage: "English"
 *                   selectedLanguageFlag: "🇺🇸"
 *                 defaultAddress:
 *                   id: "adr_1"
 *                   streetAddress: "4521 Westheimer Rd"
 *                   city: "Houston"
 *                   state: "TX"
 *                   zip: "77027"
 *                 defaultPaymentMethod:
 *                   id: "pm_1"
 *                   brand: "Visa"
 *                   last4: "4291"
 *                   expiry: "09/28"
 *                 stats:
 *                   activeOrders: 1
 *                   savedPartsCount: 5
 *                   junkRequestsCount: 2
 *                   completedOrders: 8
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             example:
 *               success: false
 *               errors:
 *                 - msg: "A valid email address is required"
 *                   param: "email"
 *                   location: "body"
 *       409:
 *         description: Email already registered
 *         content:
 *           application/json:
 *             example:
 *               success: false
 *               message: "An account with this email already exists"
 *       429:
 *         description: Too many requests (Rate limited)
 *         content:
 *           application/json:
 *             example:
 *               success: false
 *               message: "Too many authentication attempts. Please try again after 15 minutes."
 */
router.post(
  "/register",
  mobileAuthLimiter,
  registerValidation,
  mobileAuthController.register
);

/**
 * @swagger
 * /api/v1/app/auth/login:
 *   post:
 *     summary: Log in customer
 *     tags: [Mobile App - Auth]
 *     description: Authenticates user credentials, revokes older token family if compromised, and returns access/refresh token pair with the full customer profile.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "mike@x.com"
 *               password:
 *                 type: string
 *                 format: password
 *                 example: "Password123!"
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "Login successful"
 *               tokens:
 *                 accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1c3JfMSIsImFjY291bnRUeXBlIjoiYnV5ZXIiLCJpYXQiOjE3MTIwMDAwMDAsImV4cCI6MTcxMjAwMzYwMH0.signature"
 *                 refreshToken: "7c9b83b9c6a04e3b97b0a88062de3cfa88b6038d172e2cf1758f8b030b621e25"
 *                 expiresIn: 3600
 *               user:
 *                 id: "usr_1"
 *                 fullName: "Mike Johnson"
 *                 email: "mike@x.com"
 *                 phone: "+1 609 758 1919"
 *                 location: "Houston, TX"
 *                 avatarUrl: "https://cdn.autohub.express/avatars/usr_1.jpg"
 *                 memberSince: "Mar 2024"
 *                 accountType: "buyer"
 *                 isVerified: true
 *                 status: "active"
 *                 settings:
 *                   pushNotifications: true
 *                   emailNotifications: true
 *                   priceDropAlerts: false
 *                   orderUpdates: true
 *                   chatMessages: true
 *                   notificationSounds: true
 *                   vibration: true
 *                   darkMode: true
 *                   autoDistanceUnit: true
 *                   selectedLanguage: "English"
 *                   selectedLanguageFlag: "🇺🇸"
 *                 defaultAddress:
 *                   id: "adr_1"
 *                   streetAddress: "4521 Westheimer Rd"
 *                   city: "Houston"
 *                   state: "TX"
 *                   zip: "77027"
 *                 defaultPaymentMethod:
 *                   id: "pm_1"
 *                   brand: "Visa"
 *                   last4: "4291"
 *                   expiry: "09/28"
 *                 stats:
 *                   activeOrders: 1
 *                   savedPartsCount: 5
 *                   junkRequestsCount: 2
 *                   completedOrders: 8
 *       400:
 *         description: Validation error
 *       401:
 *         description: Invalid email or password
 *         content:
 *           application/json:
 *             example:
 *               success: false
 *               message: "Invalid email or password"
 *       403:
 *         description: Account suspended
 *         content:
 *           application/json:
 *             example:
 *               success: false
 *               message: "Your account has been suspended. Please contact support."
 *       429:
 *         description: Rate limited
 */
router.post(
  "/login",
  mobileAuthLimiter,
  loginValidation,
  mobileAuthController.login
);

/**
 * @swagger
 * /api/v1/app/auth/refresh-token:
 *   post:
 *     summary: Exchange refresh token for new access and rotated refresh token
 *     tags: [Mobile App - Auth]
 *     description: Rotates refresh token in MongoDB. If a reused/compromised refresh token is detected, the entire token family is immediately revoked for security.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *                 example: "7c9b83b9c6a04e3b97b0a88062de3cfa88b6038d172e2cf1758f8b030b621e25"
 *     responses:
 *       200:
 *         description: Tokens successfully refreshed
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "Token refreshed successfully"
 *               tokens:
 *                 accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1c3JfMSIsImFjY291bnRUeXBlIjoiYnV5ZXIiLCJpYXQiOjE3MTIwMDM2MDAsImV4cCI6MTcxMjAwNzIwMH0.newsignature"
 *                 refreshToken: "a83f12019b84ef3c98d0912ab08123ef4512bc901a884efc7162ba3847291a01"
 *                 expiresIn: 3600
 *       400:
 *         description: Missing refresh token
 *       401:
 *         description: Refresh token invalid or expired
 *         content:
 *           application/json:
 *             example:
 *               success: false
 *               message: "Invalid or expired refresh token"
 *       403:
 *         description: Token reuse detected (Family revoked)
 *         content:
 *           application/json:
 *             example:
 *               success: false
 *               message: "Security alert: Compromised token detected. Please log in again."
 */
router.post(
  "/refresh-token",
  refreshTokenValidation,
  mobileAuthController.refreshToken
);

/**
 * @swagger
 * /api/v1/app/auth/profile:
 *   get:
 *     summary: Get current authenticated mobile user profile
 *     tags: [Mobile App - Auth]
 *     security:
 *       - bearerAuth: []
 *     description: Retrieves customer profile. Response is served from high-performance in-memory cache if available (sub-millisecond latency).
 *     responses:
 *       200:
 *         description: Profile retrieved successfully
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               user:
 *                 id: "usr_1"
 *                 fullName: "Mike Johnson"
 *                 email: "mike@x.com"
 *                 phone: "+1 609 758 1919"
 *                 location: "Houston, TX"
 *                 avatarUrl: "https://cdn.autohub.express/avatars/usr_1.jpg"
 *                 memberSince: "Mar 2024"
 *                 accountType: "buyer"
 *                 isVerified: true
 *                 status: "active"
 *                 settings:
 *                   pushNotifications: true
 *                   emailNotifications: true
 *                   priceDropAlerts: false
 *                   orderUpdates: true
 *                   chatMessages: true
 *                   notificationSounds: true
 *                   vibration: true
 *                   darkMode: true
 *                   autoDistanceUnit: true
 *                   selectedLanguage: "English"
 *                   selectedLanguageFlag: "🇺🇸"
 *                 defaultAddress:
 *                   id: "adr_1"
 *                   streetAddress: "4521 Westheimer Rd"
 *                   city: "Houston"
 *                   state: "TX"
 *                   zip: "77027"
 *                 defaultPaymentMethod:
 *                   id: "pm_1"
 *                   brand: "Visa"
 *                   last4: "4291"
 *                   expiry: "09/28"
 *                 stats:
 *                   activeOrders: 1
 *                   savedPartsCount: 5
 *                   junkRequestsCount: 2
 *                   completedOrders: 8
 *       401:
 *         description: Unauthorized (missing or invalid Bearer token)
 *         content:
 *           application/json:
 *             example:
 *               success: false
 *               message: "Unauthorized: No token provided"
 *       404:
 *         description: User not found
 */
router.get(
  "/profile",
  mobileApiLimiter,
  requireMobileAuth,
  mobileAuthController.getProfile
);

/**
 * @swagger
 * /api/v1/app/auth/profile:
 *   put:
 *     summary: Update mobile user profile information
 *     tags: [Mobile App - Auth]
 *     security:
 *       - bearerAuth: []
 *     description: Updates personal contact details, location, and account type. Automatically invalidates the in-memory user cache.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fullName:
 *                 type: string
 *                 example: "Mike Johnson"
 *               phone:
 *                 type: string
 *                 example: "+1 609 758 1919"
 *               location:
 *                 type: string
 *                 example: "Houston, TX"
 *               avatarUrl:
 *                 type: string
 *                 example: "https://cdn.autohub.express/avatars/usr_1.jpg"
 *               accountType:
 *                 type: string
 *                 enum: [buyer, seller, both]
 *                 example: "buyer"
 *     responses:
 *       200:
 *         description: Profile updated successfully
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "Profile updated successfully"
 *               user:
 *                 id: "usr_1"
 *                 fullName: "Mike Johnson"
 *                 email: "mike@x.com"
 *                 phone: "+1 609 758 1919"
 *                 location: "Houston, TX"
 *                 avatarUrl: "https://cdn.autohub.express/avatars/usr_1.jpg"
 *                 memberSince: "Mar 2024"
 *                 accountType: "buyer"
 *                 isVerified: true
 *                 status: "active"
 *                 settings:
 *                   pushNotifications: true
 *                   emailNotifications: true
 *                   priceDropAlerts: false
 *                   orderUpdates: true
 *                   chatMessages: true
 *                   notificationSounds: true
 *                   vibration: true
 *                   darkMode: true
 *                   autoDistanceUnit: true
 *                   selectedLanguage: "English"
 *                   selectedLanguageFlag: "🇺🇸"
 *                 defaultAddress:
 *                   id: "adr_1"
 *                   streetAddress: "4521 Westheimer Rd"
 *                   city: "Houston"
 *                   state: "TX"
 *                   zip: "77027"
 *                 defaultPaymentMethod:
 *                   id: "pm_1"
 *                   brand: "Visa"
 *                   last4: "4291"
 *                   expiry: "09/28"
 *                 stats:
 *                   activeOrders: 1
 *                   savedPartsCount: 5
 *                   junkRequestsCount: 2
 *                   completedOrders: 8
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 */
router.put(
  "/profile",
  mobileApiLimiter,
  requireMobileAuth,
  updateProfileValidation,
  mobileAuthController.updateProfile
);

/**
 * @swagger
 * /api/v1/app/auth/settings:
 *   put:
 *     summary: Update customer app settings and preferences
 *     tags: [Mobile App - Auth]
 *     security:
 *       - bearerAuth: []
 *     description: Updates notifications, dark mode, sound/vibration toggles, and UI language preferences. Invalidates in-memory user cache.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/MobileUserSettings'
 *           example:
 *             pushNotifications: true
 *             emailNotifications: true
 *             priceDropAlerts: true
 *             orderUpdates: true
 *             chatMessages: true
 *             notificationSounds: true
 *             vibration: true
 *             darkMode: true
 *             autoDistanceUnit: true
 *             selectedLanguage: "English"
 *             selectedLanguageFlag: "🇺🇸"
 *     responses:
 *       200:
 *         description: Settings updated successfully
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "Settings updated successfully"
 *               settings:
 *                 pushNotifications: true
 *                 emailNotifications: true
 *                 priceDropAlerts: true
 *                 orderUpdates: true
 *                 chatMessages: true
 *                 notificationSounds: true
 *                 vibration: true
 *                 darkMode: true
 *                 autoDistanceUnit: true
 *                 selectedLanguage: "English"
 *                 selectedLanguageFlag: "🇺🇸"
 *       401:
 *         description: Unauthorized
 */
router.put(
  "/settings",
  mobileApiLimiter,
  requireMobileAuth,
  mobileAuthController.updateSettings
);

/**
 * @swagger
 * /api/v1/app/auth/logout:
 *   post:
 *     summary: Log out mobile customer
 *     tags: [Mobile App - Auth]
 *     security:
 *       - bearerAuth: []
 *     description: Revokes the active refresh token and purges the user's cached profile from in-memory cache.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refreshToken:
 *                 type: string
 *                 example: "7c9b83b9c6a04e3b97b0a88062de3cfa88b6038d172e2cf1758f8b030b621e25"
 *     responses:
 *       200:
 *         description: Logged out successfully
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "Logged out successfully"
 *       401:
 *         description: Unauthorized
 */
router.post(
  "/logout",
  requireMobileAuth,
  mobileAuthController.logout
);

module.exports = router;
