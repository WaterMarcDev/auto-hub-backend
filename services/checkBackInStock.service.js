const cron = require("node-cron");

const BackInStockRequest = require("../models/BackInStockRequest.model");
const sendBackInStockEmail = require("./sendBackInStockEmail.service");     // by shiva

// START AUTOMATION
const startBackInStockChecker = () => {

    cron.schedule("*/5 * * * *", async () => {

        console.log(
            "🔄 Checking back in stock products..."
        );

        try {

            const pendingRequests =
                await BackInStockRequest.find({
                    notified: false
                });

            for (const request of pendingRequests) {

                // TEMP DEMO CONDITION
                // Later we will connect Wix inventory API

                const productIsInStock = true;

                    //  testing
                    // request.product_name
                    //     ?.toLowerCase()
                    //     .includes("air intake");
                        // end here

                if (productIsInStock) {

                    console.log(
                        `✅ Product in stock: ${request.product_name}`
                    );

                    const mailSent =
                        await sendBackInStockEmail(request);

                    if (mailSent) {

                        request.notified = true;

                        await request.save();
                    }
                }
            }
        } catch (err) {

            console.error(
                "Back in stock checker error:",
                err
            );
        }
    });
};

module.exports =
    startBackInStockChecker;