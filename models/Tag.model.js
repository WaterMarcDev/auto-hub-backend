const mongoose = require("mongoose");

const tagSchema = new mongoose.Schema(
    {
        barcodeNumber: {
        type: Number,
        required: true,
        unique: true,     
        index: true,
        },
        digits: {
        type: Number,
        required: true,
        },
        isUsed: {
        type: Boolean,
        default: false,
        },
        partId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "CarPart",
        default: null,
        index: true,
    },
    },
    { timestamps: true }
);

module.exports = mongoose.model("Tag", tagSchema);
