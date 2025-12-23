const mongoose = require("mongoose");

const tagSchema = new mongoose.Schema(
{
    barcode: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    isUsed: {
        type: Boolean,
        default: false,
    },
},
    { timestamps: true }
);

module.exports = mongoose.model("Tag", tagSchema, "tags");
