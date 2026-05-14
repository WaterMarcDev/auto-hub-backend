const mongoose = require("mongoose");

const CRMEmailSchema = new mongoose.Schema(
  {
    sender_email: {
      type: String,
      required: true,
    },
    subject: {
      type: String,
    },
    body: {
      type: String,
    },
    status: {
      type: String,
      default: "unread",
    },
    // each conversation -> one thread
    thread_id: {
        type: String,
        required: true,
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: false },
  },
);

module.exports = mongoose.model("CRMEmail", CRMEmailSchema);