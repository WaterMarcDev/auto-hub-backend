const mongoose = require("mongoose");

const AppRefreshTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AppUser",
      required: true,
      index: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    familyId: {
      type: String,
      required: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    isRevoked: {
      type: Boolean,
      default: false,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    replacedByToken: {
      type: String,
      default: null,
    },
    deviceInfo: {
      type: String,
      default: "Mobile Device",
    },
  },
  {
    timestamps: true,
  }
);

// TTL index to automatically prune expired tokens from MongoDB after 30 days
AppRefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("AppRefreshToken", AppRefreshTokenSchema);
