const mongoose = require("mongoose");
const s = new mongoose.Schema({
  sender_email: { type: String, required: true },
  subject: String,
  body: String,
  status: { type: String, default: "unread" },
  thread_id: { type: String, required: true },
  attachments: [{ filename: String, url: String }],
}, { timestamps: { createdAt: "created_at", updatedAt: false } });
module.exports = mongoose.model("CRMEmail", s);
