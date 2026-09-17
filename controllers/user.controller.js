const userService = require("../services/user.service");

// @desc    Get all users (Admin only)
// @route   GET /api/users
// @access  Private/Admin
const getUsers = async (req, res) => {
  try {
    const users = await userService.getUsers();
    res.json({
      success: true,
      count: users.length,
      users,
    });
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Get user by ID
// @route   GET /api/users/:id
// @access  Private/Admin
const getUserById = async (req, res) => {
  try {
    const user = await userService.getUserById(req.params.id);
    res.json({
      success: true,
      user,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("Get user by ID error:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid user ID" });
    }
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Update user
// @route   PUT /api/users/:id
// @access  Private/Admin
const updateUser = async (req, res) => {
  try {
    const user = await userService.updateUser(req.params.id, req.body);
    res.json({
      success: true,
      message: "User updated successfully",
      user,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("Update user error:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid user ID" });
    }
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private/Admin
const deleteUser = async (req, res) => {
  try {
    await userService.deleteUser(req.params.id, req.user._id);
    res.json({
      success: true,
      message: "User deleted successfully",
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("Delete user error:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid user ID" });
    }
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Create new user
// @route   POST /api/users
// @access  Private/Admin/Manager
const createUser = async (req, res) => {
  try {
    const user = await userService.createUser(req.body);
    res.status(201).json({
      success: true,
      message: "User created successfully",
      user,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("Create user error:", error);
    res.status(500).json({ error: "Server error during creation" });
  }
};

// @desc    Reset user password
// @route   PUT /api/users/:id/password
// @access  Private/Admin/Manager
const resetPassword = async (req, res) => {
  try {
    await userService.resetPassword(req.params.id, req.body.password);
    res.json({
      success: true,
      message: "Password reset successfully",
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("Reset password error:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid user ID" });
    }
    res.status(500).json({ error: "Server error" });
  }
};

// Handled By -> Added by shiva
const getStaffUsers = async (req, res) => {
  try {
    const staffUsers = await userService.getStaffUsers();
    res.json({
      success: true,
      data: staffUsers,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
// end here

module.exports = {
  getUsers,
  getUserById,
  updateUser,
  deleteUser,
  createUser,
  resetPassword,
  getStaffUsers, //added by shiva
};
