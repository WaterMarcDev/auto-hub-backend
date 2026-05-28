const mongoose = require("mongoose");

const BackInStockRequestSchema =
    new mongoose.Schema({

        customer_email: {
            type: String,
            required: true
        },

        product_name: {
            type: String,
            required: true
        },

        product_price: {
            type: String
        },

        product_image: {
            type: String
        },

        notified: {
            type: Boolean,
            default: false
        },

        created_at: {
            type: Date,
            default: Date.now
        }
    });

module.exports =
    mongoose.model(
        "BackInStockRequest",
        BackInStockRequestSchema
    );