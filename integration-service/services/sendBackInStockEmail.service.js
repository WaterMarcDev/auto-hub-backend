const sgMail = require("@sendgrid/mail");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM_EMAIL = "support@em2723.autohubexpress.us";

const sendBackInStockEmail = async (request) => {
  try {
    await sgMail.send({
      to:      request.customer_email,
      from:    FROM_EMAIL,
      subject: `${request.product_name} is Back In Stock`,
      html: `
        <div style="font-family:Arial,sans-serif;color:#334155;line-height:1.7;font-size:15px;">
          <p>Hey,</p>
          <p>Good news 🎉 — the product you requested is now back in stock.</p>
          ${request.product_image ? `<img src="${request.product_image}" alt="product" style="width:220px;border-radius:8px;display:block;margin-bottom:18px;" />` : ""}
          <div style="margin-bottom:10px;"><strong>Product:</strong> ${request.product_name}</div>
          ${request.product_price ? `<div style="margin-bottom:18px;"><strong>Price:</strong> ${request.product_price}</div>` : ""}
          <p>Hurry — inventory may run out again soon.</p>
          <hr style="margin:24px 0;border:none;border-top:1px solid #e2e8f0;" />
          <p style="font-size:13px;color:#64748b;">AutoHub Express | <a href="https://autohubexpress.us">autohubexpress.us</a></p>
        </div>
      `,
    });
    console.log(`✅ Back-in-stock email sent to ${request.customer_email}`);
    return true;
  } catch (err) {
    console.error("Back-in-stock email error:", err.response?.body || err.message);
    return false;
  }
};

module.exports = sendBackInStockEmail;
