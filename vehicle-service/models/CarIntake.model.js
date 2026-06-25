const mongoose = require("mongoose");

const carIntakeSchema = new mongoose.Schema(
  {
    vin: { type: String, required: [true, "VIN is required"], uppercase: true, trim: true },
    vinDetails: { type: Object },
    carDetails: {
      year: Number,
      make: { type: String, trim: true },
      model: { type: String, trim: true },
      trim: { type: String, trim: true },
      color: { type: String, trim: true },
      bodyClass: { type: String, trim: true },
      chassisNo: { type: String, trim: true },
      engine: { type: String, trim: true },
      engineVariant: { type: String, trim: true },
      drive: { type: String, enum: ["2WD", "4WD", "AWD", "FWD", "RWD"], trim: true },
      transmission: { type: String, enum: ["Automatic", "Manual", "CVT"], trim: true },
      scrapYardName: { type: String, trim: true, default: "RTX" },
      scrapYardLocation: { type: String, trim: true, default: "New Jersey" },
      fuelType: { type: String, trim: true },
      keys: { type: Boolean, default: false },
      weight: { type: String, trim: true },
      dimensions: { type: String, trim: true },
      description: { type: String, trim: true },
      carDetailsUploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },
    imagesStep: {
      image1: String, image2: String, image3: String, image4: String,
      image5: String, image6: String, image7: String, image8: String,
      engineImage: String, bootImage: String, belowVehicleImage: String,
      fullVehicleImage: String, imageDescription: { type: String, trim: true },
      imagesUploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },
    partDetails: {
      parts: { type: Object },
      partsDescription: { type: String, trim: true },
      partsUploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },
    price: {
      actualWeight: { type: Number, min: 0 },
      ratePerPound: { type: Number, default: 6 },
      actualPrice: { type: Number, min: 0 },
      ourPrice: { type: Number, min: 0 },
      customerPrice: { type: Number, min: 0 },
      negotiateTo: String,
      finalPrice: { type: Number, min: 0 },
      priceDescription: { type: String, trim: true },
      priceUploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },
    kyc: {
      seller: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
      sellingDate: Date,
      pickupType: { type: String, enum: ["You Pull", "We Pull", "Bulk", "Location", "Brought In"] },
      documents: { driversLicense: String, physicalPaper: String, titleCertificate: String },
      kycDescription: { type: String, trim: true },
      kycUploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },
    payment: {
      paymentMethod: String,
      paidAmount: Number,
      paymentDescription: { type: String, trim: true },
      paymentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },
    manualVinMode: { type: Boolean, default: false },
    status: {
      type: String,
      enum: [
        "vin-fetched", "details-uploaded", "images-uploaded", "parts-uploaded",
        "price-uploaded", "kyc-uploaded", "payment-done", "part-added-to-inventory",
        "car-added-to-inventory", "ready-to-scrap", "elements-scraped", "scraped",
        "sold", "towed", "intake",
      ],
      default: "intake",
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    scrapedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    scrapDate: Date,
    scrapRemarks: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,
  },
  { timestamps: true }
);

carIntakeSchema.index({ vin: 1 });
carIntakeSchema.index({ status: 1 });
carIntakeSchema.index({ "kyc.seller": 1 });
carIntakeSchema.index({ "carDetails.make": 1, "carDetails.model": 1, "carDetails.year": 1 });
carIntakeSchema.index({ createdAt: -1 });

carIntakeSchema.virtual("displayName").get(function () {
  const cd = this.carDetails || {};
  return `${cd.year || ""} ${cd.make || ""} ${cd.model || ""}${cd.trim ? ` ${cd.trim}` : ""}`.trim();
});

module.exports = mongoose.model("CarIntake", carIntakeSchema);
