const mongoose = require("mongoose");

const carIntakeSchema = new mongoose.Schema(
  {
    // Step 1: Car Details
    vin: {
      type: String,
      // required: [true, "VIN is required"],
      // unique: true,
      uppercase: true,
      trim: true,
    },
    year: {
      type: Number,
      // required: [true, "Car year is required"],
      min: [1900, "Year must be after 1900"],
      max: [new Date().getFullYear() + 1, "Year cannot be in the future"],
    },
    make: {
      type: String,
      // required: [true, "Car make is required"],
      trim: true,
    },
    model: {
      type: String,
      // required: [true, "Car model is required"],
      trim: true,
    },
    trim: {
      type: String,
      trim: true,
    },
    color: {
      type: String,
      // required: [true, "Car color is required"],
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
    engineNo: {
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
    },
    scrapYardLocation: {
      type: String,
      trim: true,
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

    // Step 2: Car Images (12 total image fields)
    carImages: {
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
    },
    imageDescription: {
      type: String,
      trim: true,
    },

    // Step 3: Car Diagnosis (Parts breakdown)
    parts: {
      frontBumper: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      rearBumper: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      fender: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      headlights: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      hood: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      doors: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      sideMirrors: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      seats: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      odometer: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      rimsTireSet: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      acCompressor: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      airIntakeManifold: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      battery: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      fuseBox: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      windowSwitches: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      engineControlModule: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      engine: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      transmissionPart: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      trunkGate: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
      latches: {
        selected: { type: Boolean, default: false },
        unit: { type: Number, default: 1 },
        quality: {
          type: String,
          enum: ["Good", "Average", "OK", "Broken", "Scratches"],
        },
        weight: String,
        dimensions: String,
      },
    },
    partsDescription: {
      type: String,
      trim: true,
    },

    // Step 4: Car Price
    weightInPounds: {
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

    // Step 5: User KYC & Car Doc
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: [true, "Seller information is required"],
    },
    sellingDate: {
      type: Date,
      required: [true, "Selling date is required"],
    },
    pickupType: {
      type: String,
      enum: ["You Pull", "We Pull"],
      required: [true, "Pickup type is required"],
    },
    documents: {
      driversLicense: String, // File path for uploaded DL
      carRegistration: String, // File path for uploaded RC
    },
    kycDescription: {
      type: String,
      trim: true,
    },

    // Step 6: Payment
    paymentMethod: {
      type: String,
      // enum: ["Cash", "Bank Transfer", "Zelle"],
      // required: [true, "Payment method is required"],
    },
    paidAmount: {
      type: Number,
      // required: [true, "Paid amount is required"],
      // min: [0, "Paid amount cannot be negative"],
    },
    paymentDescription: {
      type: String,
      trim: true,
    },

    // Status Tracking
    status: {
      type: String,
      enum: ["intake", "in-progress", "completed", "cancelled"],
      default: "intake",
    },

    // Staff Information
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Creator is required"],
    },

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
carIntakeSchema.index({ seller: 1 });
carIntakeSchema.index({ make: 1, model: 1, year: 1 });
carIntakeSchema.index({ createdAt: -1 });

// Virtual for car display name
carIntakeSchema.virtual("displayName").get(function () {
  return `${
    this.year
  } ${this.make} ${this.model}${this.trim ? ` ${this.trim}` : ""}`;
});

// Pre-save middleware for validation
carIntakeSchema.pre("save", function (next) {
  // Calculate actual price if weight and rate are provided
  if (this.weightInPounds && this.ratePerPound) {
    this.actualPrice = (this.weightInPounds * this.ratePerPound) / 100; // Convert cents to dollars
  }

  next();
});

module.exports = mongoose.model("CarIntake", carIntakeSchema);
