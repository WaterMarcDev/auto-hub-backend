const mongoose = require("mongoose");

const inventorySchema = new mongoose.Schema(
  {
    partName: {
      type: String,
      required: [true, "Part name is required"],
      trim: true,
    },
    unit: {
      type: String,
      required: [true, "Unit is required"],
      trim: true,
    },
    cleaned: {
      type: Boolean,
      default: false,
    },
    quality: {
      type: String,
    },
    location: {
      type: String,
    },
    weight: {
      type: Number,
    },
    dimensions: {
      type: String,
    },
    make: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Make",
      required: [true, "Make reference is required"],
    },
    model: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CarModel",
      required: [true, "Model reference is required"],
    },
    trim: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trim",
      required: [true, "Trim reference is required"],
    },
    year: {
      type: Number,
    },
    vin: {
      type: String,
      trim: true,
    },
    sku: {
      type: String,
      trim: true,
    },
    category: {
      type: String,
      trim: true,
      default: "Uncategorized",
    },
    // Manual per-part selling price. Additive/optional so existing
    // documents are unaffected (they simply read back as null, rendered
    // as "N/A" on the frontend). Designed to also be the target field for
    // a future automated Car Intake -> Parts pricing workflow — that
    // automation can populate this same field without any schema change.
    price: {
      type: Number,
      default: null,
      min: 0,
    },
    image: {
      type: String,
      default: null,
    },
    wixSynced: {
      type: Boolean,
      default: false,
    },
    wixSyncedAt: {
      type: Date,
    },
    // Added by shiva for CRM integration
    wixProductId: {
      type: String,
      default: null,
    },
    wixInventoryItemId: {
      type: String,
      default: null,
    },

    wixVariantId: {
      type: String,
      default: null,
    },
    // end here

    // ─── eBay Catalog Synchronization Fields ───────────────────────────────
    // Additive/optional: existing products without these fields remain
    // fully functional for Wix, CRM, and all other workflows.
    ebaySku: {
      type: String,
      default: null,
      trim: true,
    },
    ebayOfferId: {
      type: String,
      default: null,
    },
    ebayListingId: {
      type: String,
      default: null,
    },
    ebayMarketplaceId: {
      type: String,
      default: null,
    },
    ebayCategoryId: {
      type: String,
      default: null,
    },
    ebaySyncStatus: {
      type: String,
      enum: [null, "NOT_SYNCED", "VALIDATING", "PUBLISHED", "UPDATED", "FAILED", "EXCLUDED", "SKIPPED"],
      default: null,
    },
    ebaySyncError: {
      type: String,
      default: null,
    },
    ebayLastSyncedAt: {
      type: Date,
      default: null,
    },
    /** Deterministic hash of the last successfully synchronized eBay-relevant state. */
    ebaySyncHash: {
      type: String,
      default: null,
    },
    // end eBay fields
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

// Prevent parts from being inserted twice by shiva
inventorySchema.index(
  {
    vin: 1,
    partName: 1
  },
  {
    unique: true
  }
);

const Inventory = mongoose.model("Inventory", inventorySchema);

module.exports = Inventory;
