const sgMail = require("@sendgrid/mail");

sgMail.setApiKey(
    process.env.SENDGRID_API_KEY
);

const emailSignature = require("../utils/emailSignature");

const sendBackInStockEmail =
    async (request) => {

        try {

            await sgMail.send({

                to: 
                    request.customer_email,

                from:
                    "support@em2723.autohubexpress.us",
                
                subject: 
                    `${request.product_name} is Back In Stock`,
                
                html: `
                
                <div style="
                    font-family:Arial,sans-serif;
                    color:#334155;
                    line-height:1.7;
                    font-size:15px;
                ">
                
                    <p>
                        Hey,
                    </p>
                    
                    <p>
                        Good news 🎉
                    </p>
                    
                    <p>
                        The product you requested is now back in stock.
                    </p>
                    
                    <br />
                    
                    <img
                        src="${request.product_image}"
                        alt="product"
                        style="
                            width:220px;
                            border-radius:8px;
                            display:block;
                            margin-bottom:18px;
                        "
                    />
                    
                    <div style="
                        margin-bottom:10px;
                    ">
                        <strong>
                            Product:
                        </strong>
                        
                        ${request.product_name}
                    </div>
                    
                    <div style="
                        margin-bottom:18px;
                    ">
                        <strong>
                            Price:
                        </strong>
                        
                        ${request.product_price}
                    </div>
                    
                    <p>
                        Hurry - inventory may run out again soon.
                    </p>
                    
                    ${emailSignature}
                </div>
                `
            });

            console.log(
                `✅ Auto email sent to ${request.customer_email}`
            );

            return true;
        } catch (err) {

            console.error(
                "Auto mail error:",
                err.response?.body || err.message
            );

            return false;
        }
    };

module.exports = sendBackInStockEmail;