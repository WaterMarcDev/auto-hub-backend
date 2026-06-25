const User = require("../models/User");

// GET /api/users
const getUsers = async (req, res) => {
  try {
    const users = await User.find({}).select("-password").sort({ createdAt: -1 });
    res.json({ success: true, count: users.length, users });
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/users/:id
const getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, user });
  } catch (error) {
    if (error.name === "CastError") return res.status(400).json({ error: "Invalid user ID" });
    res.status(500).json({ error: "Server error" });
  }
};

// PUT /api/users/:id
const updateUser = async (req, res) => {
  try {
    const { first_name, last_name, email, role } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (email && email !== user.email) {
      const emailExists = await User.findOne({ email });
      if (emailExists) return res.status(400).json({ error: "Email already in use" });
    }

    user.first_name = first_name || user.first_name;
    user.last_name = last_name || user.last_name;
    user.email = email || user.email;
    user.role = role || user.role;
    await user.save();

    res.json({ success: true, message: "User updated successfully", user });
  } catch (error) {
    if (error.name === "CastError") return res.status(400).json({ error: "Invalid user ID" });
    res.status(500).json({ error: "Server error" });
  }
};

// DELETE /api/users/:id
const deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }

    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    if (error.name === "CastError") return res.status(400).json({ error: "Invalid user ID" });
    res.status(500).json({ error: "Server error" });
  }
};

// POST /api/users
const createUser = async (req, res) => {
  try {
    const { first_name, last_name, email, password, role } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: "User already exists with this email" });
    }

    const user = new User({ first_name, last_name, email, password, role: role || "staff" });
    await user.save();

    res.status(201).json({
      success: true,
      message: "User created successfully",
      user: {
        id: user._id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Server error during creation" });
  }
};

// PUT /api/users/:id/password
const resetPassword = async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    user.password = password;
    await user.save();

    res.json({ success: true, message: "Password reset successfully" });
  } catch (error) {
    if (error.name === "CastError") return res.status(400).json({ error: "Invalid user ID" });
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/users/staff
const getStaffUsers = async (req, res) => {
  try {
    const staffUsers = await User.find({
      role: { $regex: /^staff$/i },
    }).select("_id first_name last_name email role");

    res.json({ success: true, data: staffUsers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { getUsers, getUserById, updateUser, deleteUser, createUser, resetPassword, getStaffUsers };
