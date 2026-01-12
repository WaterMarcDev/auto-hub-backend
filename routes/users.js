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
router.get("/", permit("admin", "manager"), getUsers);

// @route   POST /api/users
// @desc    Create new user
// @access  Private/Admin/Manager
router.post("/", permit("admin", "manager"), createUser);

// @route   GET /api/users/:id
// @desc    Get user by ID
// @access  Private/Admin/Manager
router.get("/:id", permit("admin", "manager"), getUserById);

// @route   PUT /api/users/:id
// @desc    Update user
// @access  Private/Admin/Manager
router.put("/:id", permit("admin", "manager"), updateUser);

// @route   PUT /api/users/:id/password
// @desc    Reset user password
// @access  Private/Admin/Manager
router.put("/:id/password", permit("admin", "manager"), resetPassword);

// @route   DELETE /api/users/:id
// @desc    Delete user
// @access  Private/Admin
router.delete("/:id", requireAdmin, deleteUser);

module.exports = router;
