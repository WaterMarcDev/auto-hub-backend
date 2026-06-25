const mongoose = require("mongoose");
const s = new mongoose.Schema({
  customer_email: { type: String, required: true },
  product_name:   { type: String, required: true },
  product_price:  String,
  product_image:  String,
  notified:       { type: Boolean, default: false },
  created_at:     { type: Date, default: Date.now },
});
module.exports = mongoose.model("BackInStockRequest", s);
