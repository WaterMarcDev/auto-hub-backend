/**
 * User management business logic. Extracted 1:1 from
 * controllers/userController.js during the clean-architecture migration.
 */
const userRepository = require("../repositories/user.repository");

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function getUsers() {
  return userRepository.find({}).select("-password").sort({ createdAt: -1 });
}

async function getUserById(id) {
  const user = await userRepository.findById(id).select("-password");
  if (!user) {
    throw notFoundError("User not found");
  }
  return user;
}

async function updateUser(id, { first_name, last_name, email, role }) {
  const user = await userRepository.findById(id);
  if (!user) {
    throw notFoundError("User not found");
  }

  if (email && email !== user.email) {
    const emailExists = await userRepository.findOne({ email });
    if (emailExists) {
      throw badRequestError("Email already in use");
    }
  }

  user.first_name = first_name || user.first_name;
  user.last_name = last_name || user.last_name;
  user.email = email || user.email;
  user.role = role || user.role;

  await userRepository.save(user);
  return user;
}

async function deleteUser(id, requestingUserId) {
  const user = await userRepository.findById(id);
  if (!user) {
    throw notFoundError("User not found");
  }

  if (user._id.toString() === requestingUserId.toString()) {
    throw badRequestError("Cannot delete your own account");
  }

  await userRepository.findByIdAndDelete(id);
}

async function createUser({ first_name, last_name, email, password, role }) {
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

async function resetPassword(id, password) {
  if (!password || password.length < 6) {
    throw badRequestError("Password must be at least 6 characters");
  }

  const user = await userRepository.findById(id);
  if (!user) {
    throw notFoundError("User not found");
  }

  // The User model pre-save hook handles hashing if 'password' field is
  // modified. So we just set it.
  user.password = password;
  await userRepository.save(user);
}

async function getStaffUsers() {
  return userRepository
    .find({ role: { $regex: /^staff$/i } })
    .select("_id first_name last_name email role");
}

module.exports = {
  getUsers,
  getUserById,
  updateUser,
  deleteUser,
  createUser,
  resetPassword,
  getStaffUsers,
};
