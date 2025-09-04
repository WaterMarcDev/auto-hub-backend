const mongoose = require("mongoose");

const sellerSchema = new mongoose.Schema(
  {
    // Personal Information from form
    firstName: {
      type: String,
      required: [true, "First name is required"],
      trim: true,
      maxlength: [50, "First name cannot be more than 50 characters"],
    },
    lastName: {
      type: String,
      required: [true, "Last name is required"],
      trim: true,
      maxlength: [50, "Last name cannot be more than 50 characters"],
    },
    mobileNo: {
      type: String,
      required: [true, "Mobile number is required"],
      match: [/^\+?[\d\s\-\(\)]+$/, "Please enter a valid mobile number"],
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      lowercase: true,
      trim: true,
      match: [
        /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
        "Please enter a valid email",
      ],
    },

    // Document Upload
    driversLicense: {
      type: String, // File path for uploaded DL-DMB
    },

    // Description
    description: {
      type: String,
      trim: true,
    },

    // Metadata
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  }
);

// Index for performance
sellerSchema.index({ email: 1 });
sellerSchema.index({ mobileNo: 1 });
sellerSchema.index({ createdAt: -1 });

// Virtual for full name
sellerSchema.virtual("fullName").get(function () {
  return `${this.firstName} ${this.lastName}`;
});

module.exports = mongoose.model("Seller", sellerSchema);
