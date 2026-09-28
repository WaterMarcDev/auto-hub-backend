const mongoose = require("mongoose");

const CustomerSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: [true, "First name is required"],
      trim: true,
    },
    lastName: {
      // Optional: a seller may legitimately provide a single-word name (e.g.
      // "Ramesh"), in which case only firstName is populated and lastName
      // stays "". The name-split logic never fabricates a surname, and existing
      // documents that already carry a lastName remain fully valid.
      type: String,
      default: "",
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
    // Optional discriminator: distinguishes a Waiver "Seller" vs "Buyer".
    // Intentionally NOT required and with no default so existing Customer
    // documents (which predate this field) remain fully valid. Only the
    // live Waiver flow supplies this value.
    type: {
      type: String,
      enum: ["seller", "buyer"],
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
    // Additive fields used by services/smartMatch.service.js for cross-platform
    // (eBay/Amazon/social) customer matching. Optional and default-safe so
    // existing Customer documents/queries are unaffected.
    platformUserId: {
      type: String,
      default: null,
    },
    platformIds: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
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
    },
    profilePicture: {
      type: String,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
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

module.exports = mongoose.model("Customer", CustomerSchema);
