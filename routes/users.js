const express = require("express");
const {
  getUsers,
  getUserById,
  updateUser,
  deleteUser,
} = require("../controllers/userController");
const { auth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

// All routes require authentication and admin role
router.use(auth);
router.use(requireAdmin);

// @route   GET /api/users
// @desc    Get all users
// @access  Private/Admin
router.get("/", getUsers);

// @route   GET /api/users/:id
// @desc    Get user by ID
// @access  Private/Admin
router.get("/:id", getUserById);

// @route   PUT /api/users/:id
// @desc    Update user
// @access  Private/Admin
router.put("/:id", updateUser);

// @route   DELETE /api/users/:id
// @desc    Delete user
// @access  Private/Admin
router.delete("/:id", deleteUser);

module.exports = router;
