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
    // Optional CC recipients on outgoing replies — defaults to [] so existing
    // documents without this field keep working.
    cc: {
      type: [String],
      default: [],
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

    // Attachments to view the unploaded images by shiva
    attachments: [
      {
        filename: String,
        url: String,
      },
    ],
  // end here
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: false },
  },
);

module.exports = mongoose.model("CRMEmail", CRMEmailSchema);