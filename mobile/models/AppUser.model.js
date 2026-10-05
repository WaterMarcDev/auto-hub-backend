const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const config = require("../config/mobileConfig");

const AppUserSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: [true, "Full name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email address is required"],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    phone: {
      type: String,
      trim: true,
      default: "",
    },
    passwordHash: {
      type: String,
      required: [true, "Password is required"],
      select: false,
    },
    location: {
      type: String,
      trim: true,
      default: "",
    },
    avatarUrl: {
      type: String,
      default: null,
    },
    accountType: {
      type: String,
      enum: ["buyer", "seller", "both"],
      default: "buyer",
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ["active", "suspended", "pending"],
      default: "active",
      index: true,
    },

    // Mobile App Settings & Preferences
    settings: {
      pushNotifications: { type: Boolean, default: config.defaultSettings.pushNotifications },
      emailNotifications: { type: Boolean, default: config.defaultSettings.emailNotifications },
      priceDropAlerts: { type: Boolean, default: config.defaultSettings.priceDropAlerts },
      orderUpdates: { type: Boolean, default: config.defaultSettings.orderUpdates },
      chatMessages: { type: Boolean, default: config.defaultSettings.chatMessages },
      notificationSounds: { type: Boolean, default: config.defaultSettings.notificationSounds },
      vibration: { type: Boolean, default: config.defaultSettings.vibration },
      darkMode: { type: Boolean, default: config.defaultSettings.darkMode },
      autoDistanceUnit: { type: Boolean, default: config.defaultSettings.autoDistanceUnit },
      selectedLanguage: { type: String, default: config.defaultSettings.selectedLanguage },
      selectedLanguageFlag: { type: String, default: config.defaultSettings.selectedLanguageFlag },
    },

    // Default Shipping Address
    defaultAddress: {
      id: { type: String, default: null },
      streetAddress: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      zip: { type: String, default: "" },
    },

    // Default Payment Method
    defaultPaymentMethod: {
      id: { type: String, default: null },
      brand: { type: String, default: "" },
      last4: { type: String, default: "" },
      expiry: { type: String, default: "" },
    },

    // Customer Activity Metrics
    stats: {
      activeOrders: { type: Number, default: 0 },
      savedPartsCount: { type: Number, default: 0 },
      junkRequestsCount: { type: Number, default: 0 },
    },

    // Push Notification Device Tokens (never returned in public profile)
    fcmTokens: {
      type: [String],
      select: false,
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

// Hash password before saving if modified
AppUserSchema.pre("save", async function (next) {
  if (!this.isModified("passwordHash")) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// Compare password helper
AppUserSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

// Compound index for search
AppUserSchema.index({ email: 1, status: 1 });
AppUserSchema.index({ phone: 1 });

module.exports = mongoose.model("AppUser", AppUserSchema);
