// Scrap Material Purchase — fully independent entity.
//
// This model intentionally has NO coupling to CarIntake, PaymentSlip, Invoice,
// or the Transaction post-save hooks. It owns its own numbering sequence and
// its own bill snapshot. It only REUSES the proven Nunjucks + autoPrint/iframe
// rendering pattern (via views/scrapPurchaseBill.njk), never the billing models.
//
// Price model (per approved requirements):
//   weightLbs  : quantity of scrap material purchased, in pounds
//   pricePerLb : negotiated rate per pound
//   totalAmount: the effective purchase total (editable override). When the
//                user does not provide an override, it defaults to
//                weightLbs * pricePerLb. This explicit override prevents any
//                double-multiplication surprises at print time.

const mongoose = require("mongoose");

const { Schema } = mongoose;

// Own counter collection namespace: "scrapPurchase". Self-contained so the
// existing paymentSlip/invoice counters are never touched.
const Counter =
  mongoose.models.Counter ||
  mongoose.model(
    "Counter",
    new Schema(
      { _id: String, seq: { type: Number, default: 0 } },
      { collection: "counters", timestamps: false }
    )
  );

async function getNextSequence(name) {
  const doc = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  ).exec();
  return doc.seq;
}

// One bill line item. A purchase may contain several materials in one bill.
const ScrapPurchaseItemSchema = new Schema(
  {
    materialName: {
      type: String,
      trim: true,
      default: "Scrap Material",
    },
    description: {
      type: String,
      trim: true,
    },
    weightLbs: {
      type: Number,
      default: 0,
      min: [0, "Weight cannot be negative"],
    },
    pricePerLb: {
      type: Number,
      default: 0,
      min: [0, "Price per lb cannot be negative"],
    },
    // Effective line total. When omitted it is derived as weightLbs * pricePerLb.
    // Stored explicitly so an operator override always wins and is what prints.
    totalAmount: {
      type: Number,
      default: 0,
      min: [0, "Line total cannot be negative"],
    },
  },
  { _id: false }
);

const ScrapPurchaseSchema = new Schema(
  {
    // Human-facing bill number, padded at print time (e.g. 0000001).
    billNumber: { type: Number, index: true, unique: true, sparse: true },
    billPrefix: { type: String, default: "SP" },

    // Short label for the whole purchase, used as the bill's primary line when
    // no explicit items[] are supplied.
    materialName: {
      type: String,
      trim: true,
      default: "Scrap Material",
    },

    // Top-level weight/rate/total (mirrors item[0] for single-material bills).
    weightLbs: {
      type: Number,
      default: 0,
      min: [0, "Weight cannot be negative"],
    },
    pricePerLb: {
      type: Number,
      default: 0,
      min: [0, "Price per lb cannot be negative"],
    },
    totalAmount: {
      type: Number,
      default: 0,
      min: [0, "Total cannot be negative"],
    },

    // Optional multi-line breakdown. When present it is authoritative for print.
    items: { type: [ScrapPurchaseItemSchema], default: [] },

    // Supplier / seller of the scrap material. References the dedicated
    // ScrapPurchaseSeller collection — fully independent from Customer.
    supplier: { type: Schema.Types.ObjectId, ref: "ScrapPurchaseSeller" },
    // Denormalized supplier snapshot (name + phone) so historical bills keep
    // rendering correctly even if the seller record is later hard-deleted.
    supplierSnapshot: { type: Schema.Types.Mixed, default: {} },

    paymentMethod: { type: String, trim: true },
    paymentDate: { type: Date, default: Date.now },
    note: { type: String, trim: true },

    // No tax for scrap payouts by default (matches car-payout behavior). Kept
    // as a field so a future decision can change it without a data migration.
    taxRate: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },

    // Snapshot of the exact values that were rendered the last time the bill
    // was printed. Print always reads current fields; this is for audit only.
    billSnapshot: { type: Schema.Types.Mixed, default: {} },

    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    printedAt: { type: Date },

    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true }
);

// Normalize totals before save so the DB never stores a stale/blank total.
// Rule: an explicit totalAmount (> 0) always wins; otherwise derive from
// weightLbs * pricePerLb. This is the single source of truth for the amount.
ScrapPurchaseSchema.pre("save", async function (next) {
  try {
    if (this.isNew && !this.billNumber) {
      const seq = await getNextSequence("scrapPurchase");
      this.billNumber = seq;
    }

    const normalizeItem = (item) => {
      const weight = Number(item.weightLbs || 0);
      const rate = Number(item.pricePerLb || 0);
      const providedTotal = Number(item.totalAmount || 0);
      const total = providedTotal > 0 ? providedTotal : weight * rate;
      return { weight, rate, total };
    };

    // Normalize item lines
    if (Array.isArray(this.items) && this.items.length) {
      this.items.forEach((item) => {
        const { total } = normalizeItem(item);
        item.totalAmount = Math.round((total + Number.EPSILON) * 100) / 100;
      });
    }

    // Normalize the top-level totals
    const weight = Number(this.weightLbs || 0);
    const rate = Number(this.pricePerLb || 0);
    const providedTotal = Number(this.totalAmount || 0);

    if (Array.isArray(this.items) && this.items.length) {
      // For multi-line bills the top-level total is the sum of the lines by
      // default. An explicit top-level override (a provided total that differs
      // from the summed line totals) is authoritative and is preserved, so the
      // operator's Grand Total is what gets stored and printed.
      const sum = this.items.reduce(
        (acc, it) => acc + Number(it.totalAmount || 0),
        0
      );
      const roundedSum = Math.round((sum + Number.EPSILON) * 100) / 100;
      const useOverride =
        Number.isFinite(providedTotal) &&
        providedTotal > 0 &&
        Math.abs(providedTotal - roundedSum) > 0.009;
      this.totalAmount = useOverride
        ? Math.round((providedTotal + Number.EPSILON) * 100) / 100
        : roundedSum;
    } else {
      const total = providedTotal > 0 ? providedTotal : weight * rate;
      this.totalAmount = Math.round((total + Number.EPSILON) * 100) / 100;
    }

    // taxRate is intentionally honored (default 0) so no payout inflation occurs.
    const taxRate = Number(this.taxRate || 0);
    this.taxAmount =
      Math.round(
        (Math.abs(this.totalAmount) * taxRate + Number.EPSILON) * 100
      ) / 100;

    return next();
  } catch (err) {
    return next(err);
  }
});

// Indexes for the list view (bounded, additive to a brand-new collection).
ScrapPurchaseSchema.index({ createdAt: -1 });
ScrapPurchaseSchema.index({ materialName: 1 });
ScrapPurchaseSchema.index({ isDeleted: 1, isActive: 1 });

module.exports =
  mongoose.models.ScrapPurchase ||
  mongoose.model("ScrapPurchase", ScrapPurchaseSchema);
