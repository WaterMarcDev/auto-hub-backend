/**
 * InventoryTransaction — audit ledger of every stock quantity change.
 *
 * Written by services/inventoryLedger.service.js. `key` is the idempotency
 * key (e.g. "ebay-sale:<orderId>:<lineItemId>"); it is unique, so one order
 * line is recorded once. The stock change itself is protected by the same
 * key stored on the Inventory document in the same atomic update.
 */
const mongoose = require("mongoose");

const SOURCES = [
  "EBAY_SALE",
  "WIX_SALE",
  "CRM_SALE",
  "EBAY_CANCELLATION",
  "WIX_CANCELLATION",
  "EBAY_RETURN",
  "EBAY_RESTOCK",
  "MANUAL_ADJUSTMENT",
  "RECONCILIATION",
];

const InventoryTransactionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    inventoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Inventory", index: true },
    sku: { type: String },
    source: { type: String, enum: SOURCES, required: true },
    type: { type: String, enum: ["deduct", "restore", "adjust", "info"], required: true },
    quantity: { type: Number, default: 0 },      // size of the change (positive)
    previousQuantity: { type: Number },
    newQuantity: { type: Number },
    channel: { type: String },                   // ebay | wix | crm
    orderId: { type: String, index: true },
    orderLineItemId: { type: String },
    listingId: { type: String },
    returnId: { type: String },
    refundId: { type: String },
    // applied   — stock changed
    // rejected  — not enough stock / part removed (nothing changed)
    // recorded  — informational (no stock change, e.g. refund without return)
    status: { type: String, enum: ["applied", "rejected", "recorded"], required: true },
    reason: { type: String },
    details: { type: mongoose.Schema.Types.Mixed },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

InventoryTransactionSchema.index({ createdAt: -1 });
InventoryTransactionSchema.index({ source: 1, orderId: 1 });

module.exports = mongoose.model("InventoryTransaction", InventoryTransactionSchema);
module.exports.SOURCES = SOURCES;
