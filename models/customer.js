const mongoose = require("mongoose");

const CustomerSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: [true, "First name is required"],
      trim: true,
    },
    lastName: {
      type: String,
      required: [true, "Last name is required"],
      trim: true,
    },
    mobileNo: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
    },
    idProofType: {
      type: String,
    },
    idProofNumber: {
      type: String,
    },
    idProofImage: {
      type: String,
    },
    signatureImage: {
      type: String,
    },
    // ─── Social & Marketplace Integration Fields ─────────────────────────
    platformUserId: {
      type: String,
      default: null,
      index: true,
    },
    platformIds: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    profilePicture: {
      type: String,
      default: null,
    },
    language: {
      type: String,
      default: "en",
    },
    country: {
      type: String,
      default: null,
    },
    source: {
      type: String,
      default: null,
      index: true,
    },
    // ─── End Social & Marketplace Fields ─────────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

CustomerSchema.virtual("carIntakes", {
  ref: "CarIntake",
  localField: "_id",
  foreignField: "seller",
  justOne: false,
});

CustomerSchema.set("toObject", { virtuals: true });
CustomerSchema.set("toJSON", { virtuals: true });

// ─── Indexes for Platform Matching ─────────────────────────────────────────

CustomerSchema.index({ platformUserId: 1 });
CustomerSchema.index({ "platformIds.facebook": 1 });
CustomerSchema.index({ "platformIds.instagram": 1 });
CustomerSchema.index({ "platformIds.whatsapp": 1 });
CustomerSchema.index({ "platformIds.amazon": 1 });
CustomerSchema.index({ "platformIds.ebay": 1 });

module.exports = mongoose.model("Customer", CustomerSchema);
