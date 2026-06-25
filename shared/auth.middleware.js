const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

// Lazy-load User model to avoid circular deps across services
let UserModel = null;
const getUserModel = () => {
  if (!UserModel) {
    // Inline schema to avoid cross-service model imports
    const userSchema = new mongoose.Schema(
      {
        first_name: String,
        last_name: String,
        email: { type: String, unique: true, lowercase: true },
        password: String,
        role: { type: String, enum: ["admin", "manager", "staff", "front_desk", "scraper"], default: "staff" },
        isDeleted: { type: Boolean, default: false },
      },
      { timestamps: true }
    );
    UserModel = mongoose.models.User || mongoose.model("User", userSchema);
  }
  return UserModel;
};

const auth = async (req, res, next) => {
  try {
    let token = req.cookies?.token;
    if (!token) {
      token = req.header("Authorization")?.replace("Bearer ", "");
    }
    if (!token) {
      return res.status(401).json({ error: "No token, authorization denied" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || "fallback_secret");
    const User = getUserModel();
    const user = await User.findById(decoded.userId).select("-password");

    if (!user) {
      return res.status(401).json({ error: "Token is not valid" });
    }

    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ error: "Token is not valid" });
  }
};

const requireAdmin = (req, res, next) => {
  if (req.user && req.user.role === "admin") return next();
  res.status(403).json({ error: "Admin access required" });
};

const permit = (...roles) => (req, res, next) => {
  if (req.user && roles.includes(req.user.role)) return next();
  res.status(403).json({ error: "Insufficient permissions" });
};

module.exports = { auth, requireAdmin, permit };
