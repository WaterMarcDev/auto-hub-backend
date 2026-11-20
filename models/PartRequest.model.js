const mongoose = require("mongoose");
const { PART_REQUEST_ALL_STATUSES } = require("../utils/partRequestLeads");

const PartRequestSchema = new mongoose.Schema(
    {
        name: String,
        phone: String,
        email: String,

        make: String,
        model: String,
        year: Number,

        partName: String,
        condition: String,
        message: String,

        remark: {
            type: String,
            default: "",
        },

        // In use: Online (website form), Offline (added in CRM), Website,
        // Instagram, Facebook — see utils/requestSources.js. The rest are
        // legacy values kept only so existing records stay valid.
        source: {
            type: String,
            enum: [
                "Online",
                "Offline",
                "Website",
                "Instagram",
                "Facebook",
                "WhatsApp",
                "TikTok",
                "eBay",
                "Google Business",
                "SMS",
                "Other",
            ],
            default: "Online"
        },

        // Settable: Pending, Lead Converted, Lead Lost, Lead Closed. The old
        // values stay in the enum so existing records keep validating — see
        // utils/partRequestLeads.js.
        status: {
            type: String,
            enum: PART_REQUEST_ALL_STATUSES,
            default: "Pending"
        },

        // Stamped once when status transitions to "Completed" — used by the
        // Social Media Leads report (completed, social-sourced requests).
        completedAt: {
            type: Date,
            default: null,
        },
        // added by shiva
        fulfilledBy: {
            type: String,
            default: null
        },
        // end here

        // Set when this request is auto-created by the Automation Bot (chatbot)
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model("PartRequest", PartRequestSchema);