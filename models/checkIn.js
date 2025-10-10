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

const CheckIn = mongoose.model("CheckIn", checkInSchema);

module.exports = CheckIn;
