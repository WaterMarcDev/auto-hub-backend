const mongoose = require("mongoose");

const checkInSchema = new mongoose.Schema({
  checkInToken: {
    type: String,
    unique: true,
    trim: true,
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Customer",
    required: [true, "Customer reference is required"],
  },
  numberOfPersons: {
    type: Number,
  },
  transaction: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Transaction",
    required: [true, "Transaction reference is required"],
  },
  employeeSignature: {
    type: String,
    trim: true,
  },
  checkInTime: {
    type: Date,
    default: Date.now,
  },
  checkOutTime: {
    type: Date,
  },
  status: {
    type: String,
    enum: ["checked-in", "checked-out"],
    default: "checked-in",
  },
  checkedInBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  checkedOutBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  invoicePrinted: {
    type: Boolean,
    default: false,
  },
});

checkInSchema.pre("save", function (next) {
  if (!this.checkInToken) {
    // Generate a unique 6 character alphanumeric token
    this.checkInToken = Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase();
  }
  next();
});

// After saving a check-in, create an Invoice snapshot if appropriate
checkInSchema.post("save", async function (doc, next) {
  try {
    // Only create invoice for check-ins with a transaction
    if (!doc || !doc.transaction) return next();
    if (doc.status !== "checked-in") return next();

    // Lazy require to avoid circular dependency during module load
    let Invoice;
    try {
      Invoice = require("./Invoice");
    } catch (e) {
      // If Invoice model not present, skip silently
      return next();
    }

    // Avoid creating duplicate invoice for same check-in
    const existing = await Invoice.findOne({ checkIn: doc._id });
    if (existing) return next();

    // Create invoice snapshot
    await Invoice.createFrom({
      checkInId: doc._id,
      transactionId: doc.transaction,
      snapshot: {
        amount: 0, // Will be populated from transaction when it's available
        taxRate: 0,
        invoiceDate: doc.checkInTime,
      },
      createdBy: doc.checkedInBy,
    });

    return next();
  } catch (e) {
    console.error("Error creating invoice for check-in:", e);
    return next(); // Don't fail the check-in save if invoice creation fails
  }
});

const CheckIn = mongoose.model("CheckIn", checkInSchema);

module.exports = CheckIn;
