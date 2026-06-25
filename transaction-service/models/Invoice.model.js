const mongoose = require("mongoose");
const { Schema } = mongoose;

const Counter = mongoose.models.Counter || mongoose.model("Counter",
  new Schema({ _id: String, seq: { type: Number, default: 0 } }, { collection: "counters" })
);

async function getNextSeq(name) {
  const doc = await Counter.findOneAndUpdate(
    { _id: name }, { $inc: { seq: 1 } }, { upsert: true, new: true }
  );
  return doc.seq;
}

const InvoiceSchema = new Schema({
  invoiceNumber: { type: Number, index: true, unique: true },
  invoicePrefix: { type: String, default: "INV" },
  checkIn: { type: Schema.Types.ObjectId, ref: "CheckIn" },
  elementSell: { type: Schema.Types.ObjectId, ref: "ElementHubHistory" },
  invoiceType: { type: String, enum: ["checkin", "element-sell"], default: "checkin" },
  transaction: { type: Schema.Types.ObjectId, ref: "Transaction" },
  invoiceData: Schema.Types.Mixed,
  paymentMethod: String,
  amount: { type: Number, default: 0 },
  taxRate: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  subtotal: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  amountPaid: { type: Number, default: 0 },
  balanceDue: { type: Number, default: 0 },
  invoiceDate: Date,
  createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  printedAt: Date,
  pdfUrl: String,
  isActive: { type: Boolean, default: true },
  isDeleted: { type: Boolean, default: false },
}, { timestamps: true });

InvoiceSchema.pre("save", async function (next) {
  try {
    if (this.isNew && !this.invoiceNumber) this.invoiceNumber = await getNextSeq("invoice");
    if (typeof this.amount === "number") {
      const rate = this.taxRate || 0;
      this.subtotal = this.amount;
      this.taxAmount = Math.round(Math.abs(this.subtotal) * rate * 100) / 100;
      this.total = Math.round((this.subtotal + this.taxAmount) * 100) / 100;
      if (this.amountPaid == null) this.amountPaid = 0;
      this.balanceDue = Math.round((this.total - this.amountPaid) * 100) / 100;
    }
    next();
  } catch (err) { next(err); }
});

InvoiceSchema.statics.createFrom = async function ({ checkInId, transactionId, snapshot = {}, createdBy, elementSellId, invoiceType = "checkin" }) {
  const inv = new this({
    checkIn: checkInId, transaction: transactionId, invoiceData: snapshot,
    paymentMethod: snapshot.paymentMethod, amount: Number(snapshot.amount ?? 0),
    taxRate: snapshot.taxRate ?? 0,
    invoiceDate: snapshot.invoiceDate ? new Date(snapshot.invoiceDate) : undefined,
    createdBy, elementSell: elementSellId, invoiceType,
  });
  await inv.save();
  return inv;
};

module.exports = mongoose.models.Invoice || mongoose.model("Invoice", InvoiceSchema);
