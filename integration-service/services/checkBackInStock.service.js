const cron = require("node-cron");
const BackInStockRequest  = require("../models/BackInStockRequest.model");
const sendBackInStockEmail = require("./sendBackInStockEmail.service");

const startBackInStockChecker = () => {
  cron.schedule("*/5 * * * *", async () => {
    console.log("🔄 Checking back-in-stock requests...");
    try {
      const pending = await BackInStockRequest.find({ notified: false });
      for (const request of pending) {
        // Condition: product is considered back-in-stock (extend with Wix API check if needed)
        const inStock = true;
        if (inStock) {
          const sent = await sendBackInStockEmail(request);
          if (sent) { request.notified = true; await request.save(); }
        }
      }
    } catch (err) {
      console.error("Back-in-stock checker error:", err.message);
    }
  });
};

module.exports = startBackInStockChecker;
