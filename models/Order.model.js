const mongoose = require("mongoose");

const OrderSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      required: true,
      default: "ebay",
      index: true,
    },

    orderId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    legacyOrderId: {
      type: String,
      default: null,
    },

    buyerUsername: {
      type: String,
      default: null,
    },

    buyerEmail: {
      type: String,
      default: null,
    },

    status: {
      type: String,
      default: null,
    },

    createdAtEbay: {
      type: Date,
      default: null,
    },

    total: {
      type: Number,
      default: 0,
    },

    currency: {
      type: String,
      default: "USD",
    },

    items: [
      {
        itemId: String,
        title: String,
        sku: String,
        quantity: Number,
        price: Number,
      },
    ],

    shippingAddress: {
      name: String,
      city: String,
      state: String,
      postalCode: String,
      country: String,
    },

    rawData: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Order", OrderSchema);