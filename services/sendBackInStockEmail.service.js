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
                    "support@mail.autohubexpress.us",
                
                subject: 
                    `${request.product_name} is Back In Stock`,
                
                html: `
                    
                    <div style="
                        font-family:Arial,sans-serif;
                        line-height:1.7;
                        color:#334155;
                    ">
                    
                        <h2 style="
                            color:#0f172a;
                            margin-bottom:16px;
                        ">
                            Good News 🎉
                        
                        </h2>
                        
                        <p>
                            The product you requested
                            is now back in stock.
                        </p>
                        
                        <div style="
                            margin-top:18px;
                            padding:16px;
                            border:1px solid #e2e8f0;
                            border-radius:12px;
                        ">
                        
                            <img
                                src="${request.product_image}"
                                alt="product"
                                style="
                                    width:220px;
                                    border-radius:10px;
                                    margin-bottom:12px;
                                "
                            />
                            
                            <div>
                                <strong>
                                    Product:
                                </strong>
                                
                                ${request.product_name}
                            </div>
                            
                            <div style="
                                margin-top:8px;
                            ">
                                <strong>
                                    Price:
                                </strong>
                                
                                ${request.product_price}
                            </div>
                            
                        </div>
                        
                        <p style="
                            margin-top:20px;
                        ">
                            Hurry -
                            inventory may run out again soon.
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