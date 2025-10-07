const mongoose = require("mongoose");

const carIntakeSchema = new mongoose.Schema(
  {
    // Step 1: Car Details
    vin: {
      type: String,
      required: [true, "VIN is required"],
      unique: true,
      uppercase: true,
      trim: true,
    },
    vinDetails: {
      type: Object,
    },
    carDetails: {
      year: {
        type: Number,
      },
      make: {
        type: String,
        trim: true,
      },
      model: {
        type: String,
        trim: true,
      },
      trim: {
        type: String,
        trim: true,
      },
      color: {
        type: String,
        trim: true,
      },
      bodyClass: {
        type: String,
        trim: true,
      },
      chassisNo: {
        type: String,
        trim: true,
      },
      engine: {
        type: String,
        trim: true,
      },
      engineVariant: {
        type: String,
        trim: true,
      },
      drive: {
        type: String,
        enum: ["2WD", "4WD", "AWD", "FWD"],
        trim: true,
      },
      transmission: {
        type: String,
        enum: ["Automatic", "Manual"],
        trim: true,
      },
      scrapYardName: {
        type: String,
        trim: true,
        default: "RTX",
      },
      scrapYardLocation: {
        type: String,
        trim: true,
        default: "New Jersey",
      },
      fuelType: {
        type: String,
        trim: true,
      },
      keys: {
        type: Boolean,
        default: false,
      },
      weight: {
        type: String,
        trim: true,
      },
      dimensions: {
        type: String,
        trim: true,
      },
      description: {
        type: String,
        trim: true,
      },
      carDetailsUploadedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    },

    // Step 2: Car Images (grouped) - each step has an associated user
    imagesStep: {
      image1: String,
      image2: String,
      image3: String,
      image4: String,
      image5: String,
      image6: String,
      image7: String,
      image8: String,
      engineImage: String,
      bootImage: String,
      belowVehicleImage: String,
      fullVehicleImage: String,
      imageDescription: { type: String, trim: true },
      imagesUploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },

    // Step 3: Car Diagnosis (Parts breakdown)
    partDetails: {
      parts: {
        type: Object,
      },
      partsDescription: {
        type: String,
        trim: true,
      },
      partsUploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },
    // Step 4: Car Price (grouped)
    price: {
      actualWeight: {
        type: Number,
        min: [0, "Weight cannot be negative"],
      },
      ratePerPound: {
        type: Number,
        default: 6,
      },
      actualPrice: {
        type: Number,
        min: [0, "Actual price cannot be negative"],
      },
      ourPrice: {
        type: Number,
        min: [0, "Our price cannot be negative"],
      },
      customerPrice: {
        type: Number,
        min: [0, "Customer price cannot be negative"],
      },
      negotiateTo: {
        type: String,
      },
      finalPrice: {
        type: Number,
        min: [0, "Final price cannot be negative"],
      },
      priceDescription: {
        type: String,
        trim: true,
      },
      priceUploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },

    // Step 5: User KYC & Car Doc (grouped)
    kyc: {
      seller: { type: mongoose.Schema.Types.ObjectId, ref: "Seller" },
      sellingDate: { type: Date },
      pickupType: {
        type: String,
        enum: ["You Pull", "We Pull", "Bulk", "Location"],
      },
      documents: {
        driversLicense: String,
        carRegistration: String,
        titleCertificate: String,
      },
      sellerSignature: { type: String, trim: true },
      kycDescription: { type: String, trim: true },
      kycUploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },

    // Step 6: Payment (grouped)
    payment: {
      paymentMethod: { type: String },
      paidAmount: { type: Number },
      paymentDescription: { type: String, trim: true },
      paymentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },

    // Link to Seller (created when KYC provided)
    seller: { type: mongoose.Schema.Types.ObjectId, ref: "Seller" },

    // Status Tracking
    status: {
      type: String,
      enum: [
        "vin-fetched",
        "details-uploaded",
        "images-uploaded",
        "parts-uploaded",
        "price-uploaded",
        "kyc-uploaded",
        "payment-done",
        "part-added-to-inventory",
        "car-added-to-inventory",
        "elements-scraped",
        "scraped",
        "sold",
        "towed",
        "intake",
        "in-progress",
        "completed",
        "cancelled",
      ],
      default: "intake",
    },

    // (No global steps audit array — each step has its own uploadedBy/user field)

    // Staff Information
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    // Who scraped the car (set when status becomes 'scraped')
    scrapedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // When the car was scraped (set when status becomes 'scraped')
    scrapDate: { type: Date },

    // Metadata
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for performance
carIntakeSchema.index({ vin: 1 });
carIntakeSchema.index({ status: 1 });
carIntakeSchema.index({ "kyc.seller": 1 });
carIntakeSchema.index({
  "carDetails.make": 1,
  "carDetails.model": 1,
  "carDetails.year": 1,
});
carIntakeSchema.index({ createdAt: -1 });

// Virtual for car display name
carIntakeSchema.virtual("displayName").get(function () {
  const cd = this.carDetails || {};
  return `${cd.year || ""} ${cd.make || ""} ${cd.model || ""}${
    cd.trim ? ` ${cd.trim}` : ""
  }`.trim();
});

// Pre-save middleware for validation
carIntakeSchema.pre("save", function (next) {
  // Calculate actual price if weight and rate are provided in `price`
  if (this.price && this.price.weightInPounds && this.price.ratePerPound) {
    this.price.actualPrice =
      (this.price.weightInPounds * this.price.ratePerPound) / 100; // Convert cents to dollars
  }

  next();
});

module.exports = mongoose.model("CarIntake", carIntakeSchema);
