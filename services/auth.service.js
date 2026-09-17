/**
 * Auth business logic. Extracted 1:1 from controllers/authController.js
 * during the clean-architecture migration. JWT signing is business logic
 * (not an HTTP or data-access concern) so it lives here; password hashing
 * and comparison remain exactly where they were — inside the User model
 * (models/User.js's pre-save hook and comparePassword method), untouched.
 */
const jwt = require("jsonwebtoken");
const userRepository = require("../repositories/user.repository");

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET || "fallback_secret", {
    expiresIn: process.env.JWT_EXPIRE || "7d",
  });
}

async function register({ first_name, last_name, email, password, role }) {
  const existingUser = await userRepository.findOne({ email });
  if (existingUser) {
    throw badRequestError("User already exists with this email");
  }

  const user = new (userRepository.raw())({
    first_name,
    last_name,
    email,
    password,
    role: role || "staff",
  });

  await userRepository.save(user);

  return {
    id: user._id,
    first_name: user.first_name,
    last_name: user.last_name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
  };
}

async function login({ email, password }) {
  const user = await userRepository.findOne({ email });
  if (!user) {
    throw badRequestError("Invalid credentials");
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    throw badRequestError("Invalid credentials");
  }

  const token = generateToken(user._id);

  return {
    token,
    user: {
      id: user._id,
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    },
  };
}

module.exports = {
  generateToken,
  register,
  login,
};
