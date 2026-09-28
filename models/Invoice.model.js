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

const InvoiceSchema = new Schema(
  {
    invoiceNumber: { type: Number, index: true, unique: true },
    invoicePrefix: { type: String, default: "INV" },
    checkIn: {
      type: Schema.Types.ObjectId,
      ref: "CheckIn",
      // required only when invoiceType === 'checkin'
    },
    elementSell: {
      type: Schema.Types.ObjectId,
      ref: "ElementHubHistory",
    },
    invoiceType: {
      type: String,
      enum: ["checkin", "element-sell"],
      default: "checkin",
    },
    transaction: { type: Schema.Types.ObjectId, ref: "Transaction" },
    invoiceData: { type: Schema.Types.Mixed },
    paymentMethod: { type: String },
    amount: { type: Number, default: 0 },
    taxRate: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    subtotal: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    amountPaid: { type: Number, default: 0 },
    balanceDue: { type: Number, default: 0 },
    invoiceDate: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    printedAt: { type: Date },
    pdfUrl: { type: String },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);
// Conditional validation: require checkIn when invoiceType === 'checkin' and elementSell when invoiceType === 'element-sell'
InvoiceSchema.path("checkIn").validate(function (value) {
  if (this.invoiceType === "checkin") return !!value;
  return true;
}, "checkIn is required for checkin invoices");

InvoiceSchema.path("elementSell").validate(function (value) {
  if (this.invoiceType === "element-sell") return !!value;
  return true;
}, "elementSell is required for element-sell invoices");

InvoiceSchema.pre("save", async function (next) {
  try {
    if (this.isNew && !this.invoiceNumber) {
      const seq = await getNextSequence("invoice");
      this.invoiceNumber = seq;
    }

    // For check-in invoices, typically no tax
    // amount is the base payment amount
    // subtotal = amount
    // taxAmount = subtotal * taxRate
    // total = subtotal + taxAmount
    // amountPaid can be set explicitly or default to 0 for unpaid invoices
    // balanceDue = total - amountPaid
    if (typeof this.amount === "number") {
      const rate = typeof this.taxRate === "number" ? this.taxRate : 0;
      this.subtotal = this.amount;
      const tax =
        Math.round((Math.abs(this.subtotal) * rate + Number.EPSILON) * 100) /
        100;
      this.taxAmount = tax;
      this.total =
        Math.round((this.subtotal + tax + Number.EPSILON) * 100) / 100;

      // Only set amountPaid if not explicitly provided
      // This allows for invoices with balance due
      if (this.amountPaid === undefined || this.amountPaid === null) {
        this.amountPaid = 0; // Default to unpaid
      }

      this.balanceDue =
        Math.round((this.total - this.amountPaid + Number.EPSILON) * 100) / 100;
    }

    return next();
  } catch (err) {
    return next(err);
  }
});

InvoiceSchema.statics.createFrom = async function ({
  checkInId,
  transactionId,
  snapshot = {},
  createdBy,
  elementSellId,
  invoiceType = "checkin",
}) {
  const amt = Number(snapshot.amount ?? 0);

  const invoice = new this({
    checkIn: checkInId,
    transaction: transactionId,
    invoiceData: snapshot,
    paymentMethod: snapshot.paymentMethod || snapshot.method,
    amount: amt,
    taxRate: snapshot.taxRate ?? 0,
    invoiceDate: snapshot.invoiceDate
      ? new Date(snapshot.invoiceDate)
      : snapshot.createdAt
      ? new Date(snapshot.createdAt)
      : undefined,
    createdBy,
    elementSell: elementSellId,
    invoiceType,
  });

  await invoice.save();
  return invoice;
};

module.exports =
  mongoose.models.Invoice || mongoose.model("Invoice", InvoiceSchema);
