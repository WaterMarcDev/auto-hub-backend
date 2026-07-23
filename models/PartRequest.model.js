const mongoose = require("mongoose");

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

        status: {
            type: String,
            enum: ["Pending", "In Progress", "Completed", "Rejected"],
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