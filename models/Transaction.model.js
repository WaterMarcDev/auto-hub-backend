const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["debit", "credit"],
      required: [true, "Transaction type is required"],
    },
    amount: {
      type: Number,
    },
    // Tax fields: taxRate is a decimal (e.g., 0.1 for 10%), taxAmount is computed
    taxRate: {
      type: Number,
      // Default sales tax rate set to 6.625% (0.06625)
      default: 0.06625,
    },
    taxAmount: {
      type: Number,
      default: 0,
    },
    // netAmount is the final amount after applying tax (amount +/- taxAmount)
    netAmount: {
      type: Number,
      default: 0,
    },
    // Flag to indicate if amount represents gross or net
    // If true, amount is the net and we calculate gross from it
    amountIsNet: {
      type: Boolean,
      default: false,
    },
    carIntake: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CarIntake",
    },
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
    },
    paymentMethod: {
      type: String,
    },
    description: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["pending", "completed", "failed", "cancelled"],
      default: "pending",
    },
    transactionDate: {
      type: Date,
      default: Date.now,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Creator is required"],
    },
    isActive: {
      type: Boolean,
      default: true,
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

// Indexes for performance
transactionSchema.index({ type: 1, status: 1 });
transactionSchema.index({ transactionDate: -1 });
transactionSchema.index({ carIntake: 1 });
transactionSchema.index({ seller: 1 });
transactionSchema.index({ createdBy: 1 });
transactionSchema.index({ createdAt: -1 });

// Virtual for formatted original (gross) amount
transactionSchema.virtual("formattedAmount").get(function () {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(this.amount || 0);
});

// Virtual for formatted net amount (after tax)
transactionSchema.virtual("formattedNetAmount").get(function () {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(this.netAmount || 0);
});

// Virtual for formatted tax amount
transactionSchema.virtual("formattedTax").get(function () {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(this.taxAmount || 0);
});

// Helper to compute tax and adjust amount.
// If amountIsNet is true, amount is treated as net and we calculate gross
// Otherwise, amount is treated as gross and we calculate net
function applyTaxToAmount(amount, taxRate, type, amountIsNet = false) {
  const base = Number(amount || 0);
  const rate = Number(taxRate || 0);

  if (amountIsNet) {
    // amount is net, calculate gross
    // For debit: gross = net / (1 - rate)
    // For credit: gross = net / (1 + rate)
    let grossAmount = base;
    if (type === "debit") {
      grossAmount = base / (1 - rate);
    } else {
      grossAmount = base / (1 + rate);
    }
    const taxAmount = Number(Math.abs(grossAmount - base).toFixed(2));
    return {
      amount: Number(grossAmount.toFixed(2)),
      taxAmount,
      netAmount: base,
    };
  } else {
    // amount is gross, calculate net (original behavior)
    const tax = Number(Math.abs(base) * rate);
    const taxAmount = Number(tax.toFixed(2));
    let netAmount = base;
    if (type === "debit") {
      // debit: tax deducted from the gross amount
      netAmount = Number((base - taxAmount).toFixed(2));
    } else {
      // credit: tax added to the gross amount
      netAmount = Number((base + taxAmount).toFixed(2));
    }
    return { amount: base, taxAmount, netAmount };
  }
}

// When saving via document.save(), compute tax and set amount/taxAmount
transactionSchema.pre("save", function (next) {
  // Only run if amount is provided
  if (typeof this.amount !== "number") return next();
  const result = applyTaxToAmount(
    this.amount,
    this.taxRate,
    this.type,
    this.amountIsNet
  );
  this.amount = result.amount; // update to gross if it was net
  this.taxAmount = result.taxAmount;
  this.netAmount = result.netAmount;
  return next();
});

// When using findOneAndUpdate, compute tax if amount/type/taxRate are being changed
transactionSchema.pre("findOneAndUpdate", async function (next) {
  try {
    const update = this.getUpdate() || {};
    // normalize to $set
    const set = update.$set ? update.$set : update;

    // If neither amount nor type nor taxRate nor amountIsNet are present in the update, skip
    if (
      set.amount == null &&
      set.type == null &&
      set.taxRate == null &&
      set.amountIsNet == null
    )
      return next();

    // Fetch current document to fill missing values
    const current = await this.model.findOne(this.getQuery()).lean();
    const currentAmount =
      current && typeof current.amount === "number" ? current.amount : 0;
    const currentTaxRate =
      current && typeof current.taxRate === "number" ? current.taxRate : 0;
    const currentType = current && current.type ? current.type : "credit";
    const currentAmountIsNet =
      current && current.amountIsNet ? current.amountIsNet : false;

    // amount in update can be either gross or net depending on amountIsNet flag
    const amount = set.amount != null ? set.amount : currentAmount;
    const taxRate = set.taxRate != null ? set.taxRate : currentTaxRate;
    const type = set.type != null ? set.type : currentType;
    const amountIsNet =
      set.amountIsNet != null ? set.amountIsNet : currentAmountIsNet;

    if (typeof amount !== "number") return next();

    const result = applyTaxToAmount(amount, taxRate, type, amountIsNet);

    // Ensure $set exists and write computed values
    if (!update.$set) update.$set = {};
    update.$set.amount = result.amount; // update to gross if it was net
    update.$set.taxAmount = result.taxAmount;
    update.$set.netAmount = result.netAmount;
    // keep taxRate and type as-is (if provided they remain in update.$set)
    this.setUpdate(update);
    return next();
  } catch (err) {
    return next(err);
  }
});
// After saving a transaction, create a PaymentSlip snapshot if appropriate
transactionSchema.post("save", async function (doc, next) {
  try {
    // Only create slip for completed transactions tied to a carIntake
    if (!doc || !doc.carIntake) return next();
    if (doc.status !== "completed") return next();

    // Lazy require to avoid circular dependency during module load
    let PaymentSlip;
    try {
      PaymentSlip = require("./PaymentSlip");
    } catch (e) {
      // If PaymentSlip model not present, skip silently
      return next();
    }

    // Avoid creating duplicate slip for same transaction
    const existing = await PaymentSlip.findOne({ transaction: doc._id });
    if (existing) return next();

    // Create snapshot
    await PaymentSlip.createFrom({
      carIntakeId: doc.carIntake,
      transactionId: doc._id,
      snapshot: {
        paymentMethod: doc.paymentMethod,
        amount: doc.amount,
        grossAmount: doc.amount,
        taxRate: doc.taxRate,
        taxAmount: doc.taxAmount,
        netAmount: doc.netAmount,
        paymentDate: doc.transactionDate || doc.createdAt,
      },
      createdBy: doc.createdBy,
    });

    return next();
  } catch (err) {
    // Log and continue (do not block transaction save)
    try {
      console.error("PaymentSlip creation error:", err && err.message);
    } catch (e) {
      /* ignore */
    }
    return next();
  }
});
module.exports = mongoose.model("Transaction", transactionSchema);
