const mongoose = require("mongoose");

const junkCarSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
        },
        email: {
            type: String,
            required: true,
        },
        phone: {
            type: String,
            required: true,
        },
        year: {
            type: Number,
            required: false,
        },
        make: {
            type: String,
            required: true,
        },
        model: {
            type: String,
            required: true,
        },
        engineOrVin: {
            type: String,
        },
        remark: {
            type: String,
            default: "",
        },
        status: {
            type: String,
            default: "pending",
        },
        source: {
            type: String,
            enum: ["Online", "Offline"],
            default: "Online",
        },

        // added by shiva paymentStatus
        paymentStatus: {
        type: String,
        enum: ["Not Paid", "Cash", "Online"],
        default: "Not Paid",
        },
        movedToIntake: {
        type: Boolean,
        default: false,
        },
        // Assigned to or Handled by
        assignedTo: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
        // end here
    },
    { timestamps: true }
);

module.exports = mongoose.model("JunkCar", junkCarSchema);