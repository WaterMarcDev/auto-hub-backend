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
        Status: {
            type: String,
            default: "pending",
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model("JunkCar", junkCarSchema);