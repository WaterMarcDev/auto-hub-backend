/**
 * CRM inbound-email business logic. Extracted 1:1 from
 * controllers/email.controller.js during the clean-architecture migration.
 *
 * IMPORTANT: the "back in stock" auto-save block below intentionally
 * re-declares `customerEmail` with `const` inside its own block — this
 * SHADOWS the outer `let customerEmail` used for the CRMEmail record. That
 * is the original code's exact (if surprising) scoping; preserved exactly,
 * not "fixed", since this migration must not change existing behavior.
 */
const fs = require("fs");
const path = require("path");
const crmEmailRepository = require("../repositories/crmEmail.repository");
const backInStockRequestRepository = require("../repositories/backInStockRequest.repository");

async function processInboundEmail({ body, files, headers }) {
  console.log("📩 INBOUND EMAIL RECEIVED");
  console.log("BODY:", body);
  console.log("HEADERS:", headers);
  console.log("FILES:", files);

  const raw = body.from;
  const emailOnly = raw.match(/<(.+)>/)?.[1] || raw;
  const senderName = raw.split("<")[0]?.replace(/"/g, "")?.trim() || "Customer";

  // thread by actual customer email extracted from body
  let customerEmail = emailOnly;

  if (body.subject?.includes("back in stock request")) {
    const extractedEmail = (body.html || body.text || "").match(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
    )?.[0];

    if (extractedEmail) {
      customerEmail = extractedEmail;
    }
  }

  // attachments handling
  let attachments = [];

  const backendBaseUrl = process.env.BACKEND_URL || process.env.BASE_URL || "";

  const attachmentInfo = body["attachment-info"]; // SendGrid's attachment metadata

  if (attachmentInfo) {
    try {
      const parsedInfo = JSON.parse(attachmentInfo);

      for (const key in parsedInfo) {
        const file = parsedInfo[key];

        const uploadedFile = files?.find((f) => f.fieldname === key);
        if (uploadedFile) {
          let servedFilename = uploadedFile.filename;
          const hasExt = /\.[a-zA-Z0-9]{2,5}$/.test(uploadedFile.filename);

          if (!hasExt && file?.filename) {
            const extMatch = file.filename.match(/\.[a-zA-Z0-9]{2,5}$/);

            if (extMatch) {
              const renamedFilename = `${uploadedFile.filename}${extMatch[0]}`;

              try {
                fs.renameSync(
                  uploadedFile.path,
                  path.join(path.dirname(uploadedFile.path), renamedFilename)
                );
                servedFilename = renamedFilename;
              } catch (renameErr) {
                console.error("Attachment rename error:", renameErr);
              }
            }
          }

          attachments.push({
            filename: servedFilename,
            originalname: file?.filename || uploadedFile.originalname || servedFilename,
            url: `${backendBaseUrl}/uploads/${servedFilename}`,
          });
        }
      }
    } catch (err) {
      console.error("Attachment parse error:", err);
    }
  }

  // AUTO SAVE BACK IN STOCK REQUESTS
  if (body.subject?.toLowerCase().includes("back in stock")) {
    const customerEmail = body.html?.match(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
    )?.[0];

    const cleanHtml = body.html || "";

    const productName =
      cleanHtml.replace(/\n/g, " ").match(/<img[^>]+alt="([^"]+)"/i)?.[1] ||
      cleanHtml.match(/Product:\s*([^<]+)/i)?.[1] ||
      cleanHtml.match(/font-size[^>]*>([^<]{5,80})</i)?.[1] ||
      "Unknown Product";

    const productImage =
      (body.html?.match(/https:\/\/static\.wixstatic\.com[^"]+/i) || [])[0] || "";

    const productPriceMatch = (body.text || body.html || "").match(/\$\d+(\.\d{2})?/i);

    const productPrice = productPriceMatch ? productPriceMatch[0] : "";

    if (customerEmail) {
      const exists = await backInStockRequestRepository.findOne({
        customer_email: customerEmail,
        product_name: productName,
        notified: false,
      });

      if (!exists) {
        await backInStockRequestRepository.create({
          customer_email: customerEmail,
          product_name: productName,
          product_price: productPrice,
          product_image: productImage,
        });

        console.log("✅ Back in stock request saved");
      }
    }
  }

  const email = await crmEmailRepository.create({
    sender_name: senderName,
    sender_email: customerEmail,
    subject: body.subject,
    body: body.html || body.text || "",
    thread_id: customerEmail,
    status: "unread",
    created_at: new Date(),
    attachments,
  });

  return email;
}

async function createTestEmail() {
  return crmEmailRepository.create({
    sender_email: "sam@gmail.com",
    subject: "Car Product",
    body: "Hello, I am Sam and I want a good condition Front Bumper for Hyundai Creta 2000 model.",
  });
}

async function getAllEmails() {
  return crmEmailRepository.find().sort({ created_at: -1 });
}

module.exports = {
  processInboundEmail,
  createTestEmail,
  getAllEmails,
};
