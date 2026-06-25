const mongoose = require("mongoose");

function applyTax(amount, taxRate, type, amountIsNet = false) {
  const base = Number(amount || 0);
  const rate = Number(taxRate || 0);
  if (amountIsNet) {
    const gross = type === "debit" ? base / (1 - rate) : base / (1 + rate);
    return { amount: +gross.toFixed(2), taxAmount: +Math.abs(gross - base).toFixed(2), netAmount: base };
  }
  const tax = +Math.abs(base * rate).toFixed(2);
  const net = type === "debit" ? +(base - tax).toFixed(2) : +(base + tax).toFixed(2);
  return { amount: base, taxAmount: tax, netAmount: net };
}

const transactionSchema = new mongoose.Schema({
  type: { type: String, enum: ["debit", "credit"], required: true },
  amount: Number,
  taxRate: { type: Number, default: 0.06625 },
  taxAmount: { type: Number, default: 0 },
  netAmount: { type: Number, default: 0 },
  amountIsNet: { type: Boolean, default: false },
  carIntake: { type: mongoose.Schema.Types.ObjectId, ref: "CarIntake" },
  seller: { type: mongoose.Schema.Types.ObjectId, ref: "Seller" },
  junkCar: { type: mongoose.Schema.Types.ObjectId, ref: "JunkCar" },
  paymentMethod: String,
  description: { type: String, trim: true },
  status: { type: String, enum: ["pending", "completed", "failed", "cancelled"], default: "pending" },
  transactionDate: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  isActive: { type: Boolean, default: true },
  isDeleted: { type: Boolean, default: false },
  deletedAt: Date,
}, { timestamps: true });

transactionSchema.index({ type: 1, status: 1 });
transactionSchema.index({ transactionDate: -1 });
transactionSchema.index({ carIntake: 1 });
transactionSchema.index({ createdBy: 1 });

transactionSchema.pre("save", function (next) {
  if (typeof this.amount !== "number") return next();
  const r = applyTax(this.amount, this.taxRate, this.type, this.amountIsNet);
  this.amount = r.amount; this.taxAmount = r.taxAmount; this.netAmount = r.netAmount;
  next();
});

transactionSchema.pre("findOneAndUpdate", async function (next) {
  try {
    const update = this.getUpdate() || {};
    const set = update.$set ? update.$set : update;
    if (set.amount == null && set.type == null && set.taxRate == null) return next();
    const current = await this.model.findOne(this.getQuery()).lean();
    const r = applyTax(
      set.amount ?? current?.amount ?? 0,
      set.taxRate ?? current?.taxRate ?? 0,
      set.type ?? current?.type ?? "credit",
      set.amountIsNet ?? current?.amountIsNet ?? false
    );
    if (!update.$set) update.$set = {};
    update.$set.amount = r.amount; update.$set.taxAmount = r.taxAmount; update.$set.netAmount = r.netAmount;
    this.setUpdate(update);
    next();
  } catch (err) { next(err); }
});

module.exports = mongoose.models.Transaction || mongoose.model("Transaction", transactionSchema);
