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

        status: {
            type: String,
            enum: ["Pending", "In Progress", "Completed"],
            default: "Pending"
        }
    },
    { timestamps: true }
);

module.exports = mongoose.model("PartRequest", PartRequestSchema);