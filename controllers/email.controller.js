const CRMEmail = require("../models/CRMEmail.model");

const BackInStockRequest = require("../models/BackInStockRequest.model");    // added by shiva

// attachments update by shiva
const fs = require("fs");
const path = require("path");


// handleInboundEmail by shiva
const handleInboundEmail = async (req, res) => {
  try {
    console.log("📩 INBOUND EMAIL RECEIVED");
    
    console.log("BODY:", req.body); // DEBUG
    console.log("HEADERS:", req.headers);    // DEBUG
    console.log("FILES:", req.files);

    const raw = req.body.from;
    const emailOnly = raw.match(/<(.+)>/)?.[1] || raw;
    const senderName = 
      raw.split("<")[0]
        ?.replace(/"/g, "")
        ?.trim() || "Customer"


    // thread by actual customer email extracted from body:  by shiva
    let customerEmail = emailOnly;

    if (
      req.body.subject?.includes("back in stock request")
    ) {
      const extractedEmail =
        (
          req.body.html || req.body.text || ""
        ).match(
          /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
        )?.[0];
      
      if (extractedEmail) {
        customerEmail = extractedEmail;
      }
    }
    // end here

    // attachments handling by shiva
    let attachments = [];

    const attachmentInfo =
      req.body["attachment-info"];  // SendGrid's attachment metadata
    
      if(attachmentInfo) {
        try {
          const parsedInfo = JSON.parse(attachmentInfo);

          for (const key in parsedInfo) {

            const file = parsedInfo[key];

            const uploadedFile = req.files?.find(f => f.fieldname === key);
            if (uploadedFile) {
              attachments.push({
                filename: uploadedFile.filename,
                originalname: uploadedFile.originalname,
                url: `${process.env.BACKEND_URL}/uploads/${uploadedFile.filename}`
              });
            }

        }
      } catch (err) {
        console.error("Attachment parse error:", err);
      }
    }
    // end here

    // AUTO SAVE BACK IN STOCK REQUESTS by shiva
    if (
      req.body.subject?.toLowerCase()
        .includes("back in stock")
    ) {

        const customerEmail =
          req.body.html?.match(
            /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
          )?.[0];

        const productName =
          req.body.html
            ?.match(
              /font-size:19px[^>]*>(.*?)<\/span>/i
            )?.[1]

            ?.replace(/<[^>]+>/g, "")

            ?.trim()

          ||

          req.body.html
            ?.match(
              /Product:(.*?)</i
            )?.[1]

            ?.trim()

          ||

          "Unknow Product";

        const productImage =
            (
              req.body.html?.match(
                /https:\/\/static\.wixstatic\.com[^"]+/i
              ) || []
            ) [0] || "";

        const productPriceMatch =
            (
              req.body.text || req.body.html || ""
            ).match(
              /\$\d+(\.\d{2})?/i
            );
        
        const productPrice =
            productPriceMatch
              ? productPriceMatch[0]
              : "";

        if (customerEmail) {
          const exists =
            await BackInStockRequest.findOne({
              customer_email:
                customerEmail,

              product_name:
                productName,

              notified: false
            });

          if (!exists) {
            await BackInStockRequest.create({

              customer_email:
                customerEmail,

              product_name:
                productName,

              product_price:
                productPrice,

              product_image:
                productImage
            });

            console.log("✅ Back in stock request saved");
          }
        }
    }
    // end here

    const email = await CRMEmail.create({
      sender_name: senderName,
      sender_email: customerEmail,    // req.body.from
      subject: req.body.subject,
      body: req.body.html || req.body.text || "",
      thread_id: customerEmail,       // emailOnly
      status: "unread",
      created_at: new Date(),
      attachments, // save attachment info by shiva
    });

    // For real time by shiva
    const io = req.app.get("io");   // get socket instance

    if (io) {
        io.emit("new_email", {
            email,
        unread: true
        });
    }
//  end here

    res.status(200).json({
      message: "Email stored successfully",
      data: email,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to process inbound email" });
  }
};

// TEMP TEST FUNCTION
const testCreateEmail = async (req, res) => {
  try {
    console.log("SUBJECT:", req.body.subject);       // added  by shiva
    const email = await CRMEmail.create({
      sender_email: "sam@gmail.com",
      subject: "Car Product",
      body: "Hello, I am Sam and I want a good condition Front Bumper for Hyundai Creta 2000 model.",
    });

    res.json({
      message: "Test email inserted",
      data: email,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to insert email" });
  }
};

// GET ALL - added by shiva
const getEmails = async (req, res) => {
  try {
    const emails = await CRMEmail.find().sort({ created_at: -1 });

    res.json(emails);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch emails" });
  }
};
// end here

// // INBOUND EMAIL HANDLER (SendGrid)  by shiva
// const inboundEmail = async (req, res) => {
//   try {
//     console.log("📩 Incoming email:", req.body);

//     const { from, subject, text, html } = req.body;

//     await CRMEmail.create({
//       sender_email: from,
//       subject,
//       body: text || html,
//       status: "unread",
//       created_at: new Date(),
//       is_customer: !from.includes("autohubexpress"), // optional
//     });

//     res.sendStatus(200);
//   } catch (error) {
//     console.error("❌ Inbound error:", error);
//     res.sendStatus(500);
//   }
// };
// // end here

module.exports = {
  testCreateEmail,
  getEmails,            //added by shiva
  handleInboundEmail,  //added by shiva
};