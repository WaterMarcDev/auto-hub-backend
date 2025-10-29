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

    // Always compute tax as a deduction from gross for payment slips.
    // taxAmount = abs(grossAmount) * taxRate (rounded to cents)
    // netAmount = grossAmount - taxAmount
    if (typeof this.grossAmount === "number") {
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
  const gross = Number(snapshot.grossAmount ?? snapshot.amount ?? 0);
  // Ensure grossAmount is the subtotal (positive where appropriate)
  const slip = new this({
    carIntake: carIntakeId,
    transaction: transactionId,
    slipData: snapshot,
    paymentMethod: snapshot.paymentMethod || snapshot.method,
    grossAmount: gross,
    taxRate: snapshot.taxRate ?? 0.06625,
    // taxAmount and netAmount will be computed in pre-save to guarantee
    // deduction semantics and to avoid trusting incoming snapshot values.
    taxAmount: undefined,
    netAmount: undefined,
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
