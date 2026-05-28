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

                const productIsInStock = 

                    //  testing
                    request.product_name
                        ?.toLowerCase()
                        .includes("air intake");
                        // end here

                if (productIsInStock) {

                    console.log(
                        `✅ Product in stock: ${request.product_name}`
                    );

                    // Here we will send email
                    await sendBackInStockEmail(request);    // by shiva from console.log(`📧 Sending mail to ${request.customer_email}`);

                    //  MARK NOTIFIED
                    request.notified = true;

                    await request.save();
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