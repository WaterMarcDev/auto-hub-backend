const mongoose = require("mongoose");
const { Schema } = mongoose;

const Counter = mongoose.models.Counter || mongoose.model("Counter",
  new Schema({ _id: String, seq: { type: Number, default: 0 } }, { collection: "counters" })
);

const PaymentSlipSchema = new Schema({
  slipNumber: { type: Number, index: true, unique: true },
  carIntake: { type: Schema.Types.ObjectId, ref: "CarIntake", required: true },
  transaction: { type: Schema.Types.ObjectId, ref: "Transaction" },
  slipData: Schema.Types.Mixed,
  paymentMethod: String,
  grossAmount: Number,
  taxRate: { type: Number, default: 0.06625 },
  taxAmount: { type: Number, default: 0 },
  netAmount: { type: Number, default: 0 },
  paymentDate: Date,
  createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  isActive: { type: Boolean, default: true },
  isDeleted: { type: Boolean, default: false },
}, { timestamps: true });

PaymentSlipSchema.pre("save", async function (next) {
  try {
    if (this.isNew && !this.slipNumber) {
      const doc = await Counter.findOneAndUpdate({ _id: "paymentSlip" }, { $inc: { seq: 1 } }, { upsert: true, new: true });
      this.slipNumber = doc.seq;
    }
    const rate = this.taxRate || 0.06625;
    if (typeof this.netAmount === "number" && this.netAmount > 0) {
      this.grossAmount = Math.round((this.netAmount / (1 - rate)) * 100) / 100;
      this.taxAmount = Math.round((this.grossAmount - this.netAmount) * 100) / 100;
    } else if (typeof this.grossAmount === "number") {
      this.taxAmount = Math.round(Math.abs(this.grossAmount) * rate * 100) / 100;
      this.netAmount = Math.round((this.grossAmount - this.taxAmount) * 100) / 100;
    }
    next();
  } catch (err) { next(err); }
});

PaymentSlipSchema.statics.createFrom = async function ({ carIntakeId, transactionId, snapshot = {}, createdBy }) {
  const net = Number(snapshot.netAmount ?? 0);
  const gross = Number(snapshot.grossAmount ?? snapshot.amount ?? 0);
  const slip = new this({
    carIntake: carIntakeId, transaction: transactionId, slipData: snapshot,
    paymentMethod: snapshot.paymentMethod,
    netAmount: net > 0 ? net : undefined,
    grossAmount: net > 0 ? undefined : gross,
    taxRate: snapshot.taxRate ?? 0.06625,
    paymentDate: snapshot.paymentDate ? new Date(snapshot.paymentDate) : undefined,
    createdBy,
  });
  await slip.save();
  return slip;
};

module.exports = mongoose.models.PaymentSlip || mongoose.model("PaymentSlip", PaymentSlipSchema);
