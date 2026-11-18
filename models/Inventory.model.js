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

    // ─── Marketplace sale status (eBay / Wix → CRM) ────────────────────────
    // Set by services/marketplaceSales.service.js when an eBay or Wix order
    // for this part is found. A sold part stays in the collection (with all
    // order details below) but leaves available stock: it is no longer
    // counted or pushed by the eBay catalog sync or the Wix sync.
    // Existing documents have no value and are treated as "available".
    saleStatus: {
      type: String,
      enum: ["available", "sold"],
      default: "available",
    },
    sale: {
      type: new mongoose.Schema(
        {
          channel: { type: String, enum: ["ebay", "wix", "crm"] }, // crm = sold in store
          orderId: { type: String },        // eBay orderId / Wix order id
          orderNumber: { type: String },    // number staff/buyers see
          lineItemId: { type: String },
          quantity: { type: Number },
          price: { type: Number },          // this order line's total
          currency: { type: String },
          soldAt: { type: Date },           // order date on the marketplace
          orderStatus: { type: String },
          paymentStatus: { type: String },
          shippingStatus: { type: String },
          trackingNumber: { type: String },
          carrier: { type: String },
          buyerName: { type: String },
          buyerUsername: { type: String },
          buyerEmail: { type: String },
          buyerPhone: { type: String },
          shippingAddress: {
            name: String,
            line1: String,
            line2: String,
            city: String,
            state: String,
            postalCode: String,
            country: String,
          },
          listingId: { type: String },      // eBay item id / Wix product id
          listingTitle: { type: String },
          orderRef: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
          customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
          recordedAt: { type: Date },       // when the CRM first saw the sale
          lastSyncedAt: { type: Date },
        },
        { _id: false }
      ),
      default: null,
    },
    // ─── Stock quantity (central inventory ledger) ──────────────────────────
    // Sellable units on hand. Every change goes through
    // services/inventoryLedger.service.js (atomic, idempotent, audited in
    // InventoryTransaction). Existing parts have no value and count as 1 —
    // one record = one physical part, matching the quantity 1 every eBay
    // listing already has. Staff may raise it for parts sold piece by piece.
    quantityAvailable: { type: Number, default: 1, min: 0 },
    quantitySold: { type: Number, default: 0, min: 0 },
    // Idempotency keys of the last 100 stock changes applied to this part.
    // Written in the SAME atomic update as the quantity change, so a retried
    // event can never change stock twice. Hidden from normal reads.
    appliedTxKeys: { type: [String], default: undefined, select: false },

    // Return of a sold part (eBay return or in-store). A refund never
    // restocks: stock comes back only when staff receive the part and it
    // passes inspection.
    returnInfo: {
      type: new mongoose.Schema(
        {
          channel: { type: String },         // ebay | crm | wix
          returnId: { type: String },        // eBay return id (null for in-store)
          orderId: { type: String },
          status: {
            type: String,
            enum: ["requested", "in_transit", "delivered", "received", "inspection_passed", "inspection_failed", "closed"],
          },
          ebayState: { type: String },       // raw eBay return state
          refundStatus: { type: String },    // informational only
          requestedAt: { type: Date },
          receivedAt: { type: Date },
          inspectedAt: { type: Date },
          inspectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
          inspectionNotes: { type: String },
          updatedAt: { type: Date },
        },
        { _id: false }
      ),
      default: null,
    },

    // CRM → eBay quantity push for this part (services/ebayQuantitySync.service.js).
    ebayQuantitySync: {
      type: new mongoose.Schema(
        {
          status: { type: String, enum: ["pending", "synced", "failed", "dead", "skipped"] },
          reason: { type: String },          // which stock change queued it
          syncedQuantity: { type: Number },
          attempts: { type: Number, default: 0 },
          nextAttemptAt: { type: Date },
          lastError: { type: String },
          syncedAt: { type: Date },
          updatedAt: { type: Date },
        },
        { _id: false }
      ),
      default: null,
    },

    // Orders that sold this part AFTER it was already sold elsewhere
    // (e.g. sold on eBay and again on Wix). Needs staff attention.
    saleConflicts: {
      type: [
        new mongoose.Schema(
          {
            channel: String,
            orderId: String,
            orderNumber: String,
            soldAt: Date,
            buyerName: String,
            detectedAt: Date,
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
    },
    // Why the part left inventory, e.g. "car-scrapped" (went to the crusher
    // with its car — see services/carScrap.service.js). Null for other deletes.
    removedReason: {
      type: String,
      default: null,
    },
    removedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
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

// Serves the eBay Catalog Sync products table (filter by ebaySyncStatus,
// newest sync first) without a collection scan.
inventorySchema.index({ ebaySyncStatus: 1, ebayLastSyncedAt: -1 });

// Serves the Sold Products page (newest sale first) and order look-ups.
inventorySchema.index({ saleStatus: 1, "sale.soldAt": -1 });
inventorySchema.index({ "sale.channel": 1, "sale.orderId": 1 });
// eBay quantity push queue and return worklist.
inventorySchema.index({ "ebayQuantitySync.status": 1, "ebayQuantitySync.nextAttemptAt": 1 }, { sparse: true });
inventorySchema.index({ "returnInfo.status": 1 }, { sparse: true });

const Inventory = mongoose.model("Inventory", inventorySchema);

module.exports = Inventory;
