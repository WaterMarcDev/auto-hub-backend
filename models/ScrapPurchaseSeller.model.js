// Scrap Material Purchase — dedicated seller model.
//
// This model exists so that Scrap Purchase sellers are COMPLETELY independent
// from the shared Customer collection (and from the unrelated CarIntake
// "Seller" model). It stores only the two fields the New Seller form collects,
// with the full display name kept verbatim (never split into first/last).
//
//   name  : the exact text the operator typed, e.g. "Ramesh" or "Ramesh Kumar"
//   phone : the US phone number as entered (validation happens in the controller)

const mongoose = require("mongoose");

const ScrapPurchaseSellerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Seller name is required"],
      trim: true,
    },
    phone: {
      type: String,
      required: [true, "Seller phone number is required"],
      trim: true,
    },
  },
  { timestamps: true }
);

// Lookup helpers for the seller dropdown (search by name and phone).
ScrapPurchaseSellerSchema.index({ name: 1 });
ScrapPurchaseSellerSchema.index({ phone: 1 });

module.exports =
  mongoose.models.ScrapPurchaseSeller ||
  mongoose.model("ScrapPurchaseSeller", ScrapPurchaseSellerSchema);
