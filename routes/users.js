// by shiva
/**
 * @swagger
 * tags:
 *   name: Users
 *   description: User Management APIs
 */
//end here

const express = require("express");
const {
  getUsers,
  getUserById,
  updateUser,
  deleteUser,
  createUser,
  resetPassword,
} = require("../controllers/userController");
const { auth, requireAdmin, permit } = require("../middleware/auth");

const router = express.Router();

// All routes require authentication
router.use(auth);

// @route   GET /api/users
// @desc    Get all users
// @access  Private/Admin/Manager

// by shiva
/**
 * @swagger
 * /api/users:
 *   get:
 *     summary: Get all users
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Users fetched successfully
 */
//end here
router.get("/", permit("admin", "manager"), getUsers);

// @route   POST /api/users
// @desc    Create new user
// @access  Private/Admin/Manager

// by shiva
/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Create new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *               role:
 *                 type: string
 *     responses:
 *       201:
 *         description: User created successfully
 */
//end here
router.post("/", permit("admin", "manager"), createUser);

// @route   GET /api/users/:id
// @desc    Get user by ID
// @access  Private/Admin/Manager

// by shiva
/**
 * @swagger
 * /api/users/{id}:
 *   get:
 *     summary: Get user by ID
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User fetched successfully
 */
//end here
router.get("/:id", permit("admin", "manager"), getUserById);

// @route   PUT /api/users/:id
// @desc    Update user
// @access  Private/Admin/Manager

// by shiva
/**
 * @swagger
 * /api/users/{id}:
 *   put:
 *     summary: Update user
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User updated successfully
 */
//end here
router.put("/:id", permit("admin", "manager"), updateUser);

// @route   PUT /api/users/:id/password
// @desc    Reset user password
// @access  Private/Admin/Manager

// by shiva
/**
 * @swagger
 * /api/users/{id}/password:
 *   put:
 *     summary: Reset user password
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Password reset successfully
 */
//end here
router.put("/:id/password", permit("admin", "manager"), resetPassword);

// @route   DELETE /api/users/:id
// @desc    Delete user
// @access  Private/Admin

// by shiva
/**
 * @swagger
 * /api/users/{id}:
 *   delete:
 *     summary: Delete user
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User deleted successfully
 */
//end here
router.delete("/:id", requireAdmin, deleteUser);

module.exports = router;
