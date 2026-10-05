const jwt = require("jsonwebtoken");
const config = require("../config/mobileConfig");
const AppUser = require("../models/AppUser.model");
const mobileCache = require("../services/mobileCache.service");
const { serializeAppUser } = require("../serializers/appUser.serializer");

const requireMobileAuth = async (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Access denied. Valid Bearer token required in Authorization header.",
      });
    }

    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Access denied. Token is missing.",
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, config.jwt.secret);
    } catch (jwtErr) {
      if (jwtErr.name === "TokenExpiredError") {
        return res.status(401).json({
          success: false,
          error: "Access token has expired. Please refresh your token.",
          code: "TOKEN_EXPIRED",
        });
      }
      return res.status(401).json({
        success: false,
        error: "Invalid access token.",
        code: "INVALID_TOKEN",
      });
    }

    const rawId = String(decoded.userId).replace(/^usr_/, "");

    // 1. Check in-memory mobile cache (< 1ms)
    const cachedProfile = mobileCache.get(rawId);
    if (cachedProfile) {
      req.appUser = cachedProfile;
      req.appUserId = rawId;
      return next();
    }

    // 2. Fetch from MongoDB on cache miss
    const userDoc = await AppUser.findById(rawId).lean();
    if (!userDoc) {
      return res.status(401).json({
        success: false,
        error: "Account not found or has been removed.",
      });
    }

    if (userDoc.status !== "active") {
      return res.status(403).json({
        success: false,
        error: `Account is currently ${userDoc.status}. Please contact support.`,
      });
    }

    // Serialize and populate cache
    const serialized = serializeAppUser(userDoc);
    mobileCache.set(rawId, serialized);

    req.appUser = serialized;
    req.appUserId = rawId;
    next();
  } catch (err) {
    console.error("Mobile auth middleware error:", err);
    res.status(500).json({
      success: false,
      error: "Authentication service error",
    });
  }
};

module.exports = {
  requireMobileAuth,
};
