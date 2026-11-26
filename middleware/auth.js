const jwt = require("jsonwebtoken");
const User = require("../models/User.model");

const auth = async (req, res, next) => {
  try {
    // Try to get token from httpOnly cookie first, then fall back to Authorization header
    let token = req.cookies.token;

    if (!token) {
      token = req.header("Authorization")?.replace("Bearer ", "");
    }

    if (!token) {
      return res.status(401).json({ error: "No token, authorization denied" });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "fallback_secret"
    );
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

// For public routes that staff also use (e.g. Part Request, which the website
// posts to): when a valid CRM login comes with the request, req.user is set;
// otherwise the request continues as an anonymous one. Never rejects.
const optionalAuth = async (req, res, next) => {
  try {
    const token = req.cookies?.token || req.header("Authorization")?.replace("Bearer ", "");
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || "fallback_secret");
      const user = await User.findById(decoded.userId).select("-password");
      if (user) req.user = user;
    }
  } catch (error) {
    // invalid / expired token: treat as anonymous
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (req.user && req.user.role === "admin") {
    next();
  } else {
    res.status(403).json({ error: "Admin access required" });
  }
};

const permit = (...roles) => {
  return (req, res, next) => {
    if (req.user && roles.includes(req.user.role)) {
      next();
    } else {
      res.status(403).json({ error: "Insufficient permissions" });
    }
  };
};

module.exports = { auth, requireAdmin, permit, optionalAuth };
