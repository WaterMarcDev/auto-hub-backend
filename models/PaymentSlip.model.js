// Replace file content with a single coherent model (no duplicates)
const mongoose = require("mongoose");

const { Schema } = mongoose;

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

const PaymentSlipSchema = new Schema(
  {
    slipNumber: { type: Number, index: true, unique: true },
    slipPrefix: { type: String },
    carIntake: {
      type: Schema.Types.ObjectId,
      ref: "CarIntake",
      required: true,
    },
    transaction: { type: Schema.Types.ObjectId, ref: "Transaction" },
    slipData: { type: Schema.Types.Mixed },
    paymentMethod: { type: String },
    grossAmount: { type: Number },
    taxRate: { type: Number, default: 0.06625 },
    taxAmount: { type: Number, default: 0 },
    netAmount: { type: Number, default: 0 },
    paymentDate: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    printedAt: { type: Date },
    pdfUrl: { type: String },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

PaymentSlipSchema.pre("save", async function (next) {
  try {
    if (this.isNew && !this.slipNumber) {
      const seq = await getNextSequence("paymentSlip");
      this.slipNumber = seq;
    }

    // Tax calculation logic:
    // If netAmount is provided, calculate gross from net: gross = net / (1 - tax_rate)
    // If grossAmount is provided, calculate net from gross: net = gross - (gross * tax_rate)
    // Priority: if both are provided, use netAmount as source of truth

    if (typeof this.netAmount === "number" && this.netAmount > 0) {
      // Calculate gross from net (finalPrice is what seller receives)
      const rate = typeof this.taxRate === "number" ? this.taxRate : 0.06625;
      const gross = this.netAmount / (1 - rate);
      this.grossAmount = Math.round((gross + Number.EPSILON) * 100) / 100;
      const tax = this.grossAmount - this.netAmount;
      this.taxAmount = Math.round((tax + Number.EPSILON) * 100) / 100;
    } else if (typeof this.grossAmount === "number") {
      // Calculate net from gross (traditional way)
      const rate = typeof this.taxRate === "number" ? this.taxRate : 0.06625;
      const tax =
        Math.round((Math.abs(this.grossAmount) * rate + Number.EPSILON) * 100) /
        100;
      this.taxAmount = tax;
      this.netAmount =
        Math.round((this.grossAmount - tax + Number.EPSILON) * 100) / 100;
    }

    return next();
  } catch (err) {
    return next(err);
  }
});

PaymentSlipSchema.statics.createFrom = async function ({
  carIntakeId,
  transactionId,
  snapshot = {},
  createdBy,
}) {
  // Check if snapshot has netAmount (finalPrice) - this is what seller receives
  const net = Number(snapshot.netAmount ?? 0);
  const gross = Number(snapshot.grossAmount ?? snapshot.amount ?? 0);

  const slip = new this({
    carIntake: carIntakeId,
    transaction: transactionId,
    slipData: snapshot,
    paymentMethod: snapshot.paymentMethod || snapshot.method,
    // If netAmount is provided, use it as source of truth
    // Otherwise use grossAmount
    netAmount: net > 0 ? net : undefined,
    grossAmount: net > 0 ? undefined : gross,
    taxRate: snapshot.taxRate ?? 0.06625,
    // taxAmount and grossAmount/netAmount will be computed in pre-save
    taxAmount: undefined,
    paymentDate: snapshot.paymentDate
      ? new Date(snapshot.paymentDate)
      : snapshot.createdAt
      ? new Date(snapshot.createdAt)
      : undefined,
    createdBy,
  });

  await slip.save();
  return slip;
};

module.exports =
  mongoose.models.PaymentSlip ||
  mongoose.model("PaymentSlip", PaymentSlipSchema);
