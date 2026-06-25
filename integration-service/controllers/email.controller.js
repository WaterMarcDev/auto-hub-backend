const CRMEmail           = require("../models/CRMEmail.model");
const BackInStockRequest = require("../models/BackInStockRequest.model");

// POST /api/email/inbound  — SendGrid inbound parse webhook
const handleInboundEmail = async (req, res) => {
  try {
    const raw        = req.body.from || "";
    const emailOnly  = raw.match(/<(.+)>/)?.[1] || raw;
    const senderName = raw.split("<")[0]?.replace(/"/g, "").trim() || "Customer";

    // Use actual customer email as thread_id
    let customerEmail = emailOnly;
    if (req.body.subject?.toLowerCase().includes("back in stock request")) {
      const extracted = (req.body.html || req.body.text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
      if (extracted) customerEmail = extracted;
    }

    // Parse attachments from SendGrid
    let attachments = [];
    const attachmentInfo = req.body["attachment-info"];
    if (attachmentInfo) {
      try {
        const parsed = JSON.parse(attachmentInfo);
        for (const key in parsed) {
          const uploaded = req.files?.find(f => f.fieldname === key);
          if (uploaded) {
            attachments.push({
              filename: uploaded.filename,
              url: `${process.env.BACKEND_URL || ""}/uploads/${uploaded.filename}`,
            });
          }
        }
      } catch (e) {
        console.error("Attachment parse error:", e.message);
      }
    }

    // Auto-save back-in-stock requests
    if (req.body.subject?.toLowerCase().includes("back in stock")) {
      const html = req.body.html || "";
      const custEmail = html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
      const productName = html.replace(/\n/g, " ").match(/<img[^>]+alt="([^"]+)"/i)?.[1]
        || html.match(/Product:\s*([^<]+)/i)?.[1]
        || "Unknown Product";
      const productImage = (html.match(/https:\/\/static\.wixstatic\.com[^"]+/i) || [])[0] || "";
      const priceMatch   = (req.body.text || html || "").match(/\$\d+(\.\d{2})?/i);

      if (custEmail) {
        const exists = await BackInStockRequest.findOne({ customer_email: custEmail, product_name: productName, notified: false });
        if (!exists) {
          await BackInStockRequest.create({
            customer_email: custEmail,
            product_name: productName,
            product_price: priceMatch ? priceMatch[0] : "",
            product_image: productImage,
          });
        }
      }
    }

    const email = await CRMEmail.create({
      sender_email: customerEmail,
      subject:      req.body.subject,
      body:         req.body.html || req.body.text || "",
      thread_id:    customerEmail,
      status:       "unread",
      attachments,
    });

    // Real-time socket emit if io is available
    const io = req.app.get("io");
    if (io) io.emit("new_email", { email, unread: true });

    res.status(200).json({ message: "Email stored successfully", data: email });
  } catch (error) {
    console.error("Inbound email error:", error);
    res.status(500).json({ error: "Failed to process inbound email" });
  }
};

// GET /api/email
const getEmails = async (req, res) => {
  try {
    const page   = parseInt(req.query.page)   || 1;
    const limit  = parseInt(req.query.limit)  || 20;
    const skip   = (page - 1) * limit;
    const filter = {};
    if (req.query.status)    filter.status    = req.query.status;
    if (req.query.thread_id) filter.thread_id = req.query.thread_id;

    const [emails, total] = await Promise.all([
      CRMEmail.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit),
      CRMEmail.countDocuments(filter),
    ]);
    res.json({ emails, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch emails" });
  }
};

// PATCH /api/email/:id/read
const markRead = async (req, res) => {
  try {
    const email = await CRMEmail.findByIdAndUpdate(req.params.id, { status: "read" }, { new: true });
    if (!email) return res.status(404).json({ error: "Email not found" });
    res.json({ message: "Marked as read", data: email });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/email/back-in-stock
const getBackInStockRequests = async (req, res) => {
  try {
    const requests = await BackInStockRequest.find().sort({ created_at: -1 });
    res.json({ requests });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = { handleInboundEmail, getEmails, markRead, getBackInStockRequests };
