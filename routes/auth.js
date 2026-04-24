// by shiva
/**
 * @swagger
 * tags:
 *    name: Auth
 *    description: Authentication APIs
 */
// end here

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

// by shiva
/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *                 example: shiva
 *               email:
 *                 type: string
 *                 example: shiva@gmail.com
 *               password:
 *                 type: string
 *                 example: 123456
 *     responses:
 *       201:
 *         description: User registered successfully
 */
//end here
router.post("/register", registerValidation, register);

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public

// by shiva
/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Login user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 */
// end here
router.post("/login", loginValidation, login);

// @route   GET /api/auth/profile
// @desc    Get user profile
// @access  Private

// by shiva
/**
 * @swagger
 * /api/auth/profile:
 *   get:
 *     summary: Get logged in user profile
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profile fetched successfully
 */
// end here
router.get("/profile", auth, getProfile);

// @route   POST /api/auth/logout
// @desc    Logout user
// @access  Private

// by shiva
/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Logout user
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logout successful
 */
// end here
router.post("/logout", auth, logout);

module.exports = router;
