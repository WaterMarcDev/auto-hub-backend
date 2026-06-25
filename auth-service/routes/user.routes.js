const express = require("express");
const router = express.Router();
const {
  getUsers, getUserById, updateUser, deleteUser,
  createUser, resetPassword, getStaffUsers,
} = require("../controllers/user.controller");
const { auth, requireAdmin, permit } = require("../middleware/auth.middleware");

router.get("/staff", auth, getStaffUsers);
router.get("/", auth, requireAdmin, getUsers);
router.post("/", auth, permit("admin", "manager"), createUser);
router.get("/:id", auth, requireAdmin, getUserById);
router.put("/:id", auth, requireAdmin, updateUser);
router.put("/:id/password", auth, permit("admin", "manager"), resetPassword);
router.delete("/:id", auth, requireAdmin, deleteUser);

module.exports = router;
