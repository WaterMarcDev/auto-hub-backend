const mongoose = require("mongoose");

const junkPartRequestSchema = new mongoose.Schema(
    {
        name: String,
        phone: String,
        email: String,

        make: String,
        model: String,
        year: String,

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

module.exports = mongoose.model("JunkPartRequest", junkPartRequestSchema);