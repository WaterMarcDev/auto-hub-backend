const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const config = require("../config/mobileConfig");
const AppUser = require("../models/AppUser.model");
const AppRefreshToken = require("../models/AppRefreshToken.model");
const mobileCache = require("./mobileCache.service");
const { serializeAppUser } = require("../serializers/appUser.serializer");

class MobileAuthService {
  /**
   * Generates a signed Access Token and persists a secure Refresh Token with family tracking
   */
  async _issueTokenPair(userDoc, familyId = null, deviceInfo = "Mobile Device") {
    const userId = userDoc._id.toString();
    const tokenFamily = familyId || crypto.randomUUID();

    // 1. Issue short-lived access JWT
    const accessToken = jwt.sign(
      {
        userId,
        email: userDoc.email,
        type: "mobile_access",
      },
      config.jwt.secret,
      { expiresIn: config.jwt.accessExpiry }
    );

    // 2. Issue cryptographically secure refresh token
    const refreshTokenString = crypto.randomBytes(40).toString("hex");
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + config.jwt.refreshExpiryDays);

    await AppRefreshToken.create({
      userId: userDoc._id,
      token: refreshTokenString,
      familyId: tokenFamily,
      expiresAt,
      deviceInfo,
    });

    return {
      accessToken,
      refreshToken: refreshTokenString,
      tokenType: "Bearer",
      expiresIn: config.jwt.accessExpiry,
    };
  }

  /**
   * Register a new mobile app customer
   */
  async register({ fullName, email, password, phone, location }) {
    const normalizedEmail = email.toLowerCase().trim();

    const existing = await AppUser.findOne({ email: normalizedEmail }).lean();
    if (existing) {
      const err = new Error("An account with this email address already exists.");
      err.status = 409;
      throw err;
    }

    const newUser = new AppUser({
      fullName: fullName.trim(),
      email: normalizedEmail,
      phone: phone ? phone.trim() : "",
      passwordHash: password, // Will be hashed by pre-save hook
      location: location ? location.trim() : "",
    });

    await newUser.save();

    const serializedUser = serializeAppUser(newUser);
    mobileCache.set(newUser._id.toString(), serializedUser);

    const tokens = await this._issueTokenPair(newUser);

    return {
      tokens,
      user: serializedUser,
    };
  }

  /**
   * Authenticate mobile app customer
   */
  async login({ email, password, deviceInfo }) {
    const normalizedEmail = email.toLowerCase().trim();

    const user = await AppUser.findOne({ email: normalizedEmail }).select("+passwordHash");
    if (!user) {
      const err = new Error("Invalid email or password.");
      err.status = 401;
      throw err;
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      const err = new Error("Invalid email or password.");
      err.status = 401;
      throw err;
    }

    if (user.status !== "active") {
      const err = new Error(`Your account is ${user.status}. Please contact support.`);
      err.status = 403;
      throw err;
    }

    const serializedUser = serializeAppUser(user);
    mobileCache.set(user._id.toString(), serializedUser);

    const tokens = await this._issueTokenPair(user, null, deviceInfo);

    return {
      tokens,
      user: serializedUser,
    };
  }

  /**
   * Rotate Refresh Token (with token family breach detection)
   */
  async refreshToken({ refreshToken, deviceInfo }) {
    if (!refreshToken) {
      const err = new Error("Refresh token is required.");
      err.status = 400;
      throw err;
    }

    const tokenDoc = await AppRefreshToken.findOne({ token: refreshToken });
    if (!tokenDoc) {
      const err = new Error("Invalid refresh token.");
      err.status = 401;
      throw err;
    }

    // Token Reuse / Breach Detection: If token is already revoked, compromise detected!
    if (tokenDoc.isRevoked) {
      console.warn(`[SECURITY BREACH] Refresh token reuse detected for family ${tokenDoc.familyId}`);
      // Invalidate all tokens belonging to this family
      await AppRefreshToken.updateMany(
        { familyId: tokenDoc.familyId },
        { isRevoked: true, revokedAt: new Date() }
      );
      const err = new Error("Security alert: compromised session detected. Please log in again.");
      err.status = 401;
      throw err;
    }

    // Check expiration
    if (new Date() > tokenDoc.expiresAt) {
      const err = new Error("Refresh token has expired. Please log in again.");
      err.status = 401;
      throw err;
    }

    const user = await AppUser.findById(tokenDoc.userId);
    if (!user || user.status !== "active") {
      const err = new Error("Account not found or inactive.");
      err.status = 401;
      throw err;
    }

    // Invalidate current refresh token
    tokenDoc.isRevoked = true;
    tokenDoc.revokedAt = new Date();

    // Issue new token pair within the same family
    const tokens = await this._issueTokenPair(user, tokenDoc.familyId, deviceInfo);
    tokenDoc.replacedByToken = tokens.refreshToken;
    await tokenDoc.save();

    const serializedUser = serializeAppUser(user);
    mobileCache.set(user._id.toString(), serializedUser);

    return {
      tokens,
      user: serializedUser,
    };
  }

  /**
   * Get User Profile (Checks Cache First)
   */
  async getProfile(userId) {
    const rawId = String(userId).replace(/^usr_/, "");

    const cached = mobileCache.get(rawId);
    if (cached) return cached;

    const user = await AppUser.findById(rawId).lean();
    if (!user) {
      const err = new Error("User not found.");
      err.status = 404;
      throw err;
    }

    const serialized = serializeAppUser(user);
    mobileCache.set(rawId, serialized);
    return serialized;
  }

  /**
   * Update User Profile Fields
   */
  async updateProfile(userId, updateFields) {
    const rawId = String(userId).replace(/^usr_/, "");

    const allowed = ["fullName", "phone", "location", "avatarUrl", "accountType"];
    const updates = {};

    for (const key of allowed) {
      if (updateFields[key] !== undefined) {
        updates[key] = updateFields[key];
      }
    }

    const updatedUser = await AppUser.findByIdAndUpdate(
      rawId,
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!updatedUser) {
      const err = new Error("User not found.");
      err.status = 404;
      throw err;
    }

    // Invalidate and refresh cache
    mobileCache.del(rawId);
    const serialized = serializeAppUser(updatedUser);
    mobileCache.set(rawId, serialized);

    return serialized;
  }

  /**
   * Update Mobile Settings & Preferences
   */
  async updateSettings(userId, newSettings) {
    const rawId = String(userId).replace(/^usr_/, "");

    const settingsUpdate = {};
    const validKeys = [
      "pushNotifications",
      "emailNotifications",
      "priceDropAlerts",
      "orderUpdates",
      "chatMessages",
      "notificationSounds",
      "vibration",
      "darkMode",
      "autoDistanceUnit",
      "selectedLanguage",
      "selectedLanguageFlag",
    ];

    for (const key of validKeys) {
      if (newSettings[key] !== undefined) {
        settingsUpdate[`settings.${key}`] = newSettings[key];
      }
    }

    const updatedUser = await AppUser.findByIdAndUpdate(
      rawId,
      { $set: settingsUpdate },
      { new: true }
    );

    if (!updatedUser) {
      const err = new Error("User not found.");
      err.status = 404;
      throw err;
    }

    mobileCache.del(rawId);
    const serialized = serializeAppUser(updatedUser);
    mobileCache.set(rawId, serialized);

    return serialized;
  }

  /**
   * Revoke session on logout
   */
  async logout(userId, refreshToken) {
    const rawId = String(userId).replace(/^usr_/, "");
    mobileCache.del(rawId);

    if (refreshToken) {
      await AppRefreshToken.updateOne(
        { token: refreshToken, userId: rawId },
        { isRevoked: true, revokedAt: new Date() }
      );
    }
  }
}

module.exports = new MobileAuthService();
