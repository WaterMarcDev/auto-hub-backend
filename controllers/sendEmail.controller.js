console.log("API KEY:", process.env.SENDGRID_API_KEY);
console.log("BASE URL:", process.env.BASE_URL); // debug for BASE_URL

const CRMEmail = require("../models/CRMEmail.model");
const sgMail = require("@sendgrid/mail");
const fs = require("fs"); // added by shiva
const emailSignature = require("../utils/emailSignature"); // Added by shiva

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Reply count by shiva
function getReplyCount(subject) {
    subject = subject || ""; // added by shiva to prevent hidden runtime crashes.

    // Case 1: already in Re[n]
    const match = subject.match(/^Re\[(\d+)\]/);
    if (match) return parseInt(match[1], 10) + 1;

    // Case 2: old "Re: Re: Re:"
    const count = (subject.match(/Re:/g) || []).length;
    if (count > 0) return count + 1;

    // First reply
    return 1;
}

// Forward count by shiva
function getForwardCount(subject) {
    subject = subject || ""; // added by shiva to prevent hidden runtime crashes.

    // Case 1: already Fwd[n]
    const match = subject.match(/^Fwd\[(\d+)\]/);
    if (match) return parseInt(match[1], 10) + 1;

    // Case 2: old Fwd: Fwd:
    const count = (subject.match(/Fwd:/g) || []).length;
    if (count > 0) return count + 1;

    // First forward
    return 1;
}

const sendReply = async (req, res) => {
    const filesToCleanup = req.files || [];
    
    try {
        const { to, subject, message } = req.body;

        // Safety extraction & validation for Recipient Email
        const raw = to || "";
        const emailOnly = raw.match(/<(.+)>/)?.[1] || raw;
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!emailRegex.test(emailOnly)) {
            return res.status(400).json({ error: "Invalid recipient email address" });
        }

        // SAFETY CHECKS by shiva
        const safeSubject = subject || "No Subject";
        const safeMessage = message || ""; // Fixed server crash risk on empty message

        // Process attachments safely
        const sgAttachments = filesToCleanup.map(file => {
            const attachment = {
                filename: file.originalname,
                type: file.mimetype,
                disposition: "attachment",
            };
            if (file.path) {
                attachment.content = fs.readFileSync(file.path).toString("base64");
            }
            return attachment;
        });

        const crmAttachments = filesToCleanup.map(file => ({
            filename: file.originalname,
            url: `${process.env.BASE_URL}/uploads/${file.filename}`
        }));

        const count = getReplyCount(safeSubject);
        const cleanSubject = safeSubject
            .replace(/^Re\[\d+\]\s*/i, "")
            .replace(/^(Re:\s*)+/i, "")
            .trim();
        
        const formattedSubject = `Re[${count}] ${cleanSubject}`;

        // 1. Send via SendGrid
        await sgMail.send({
            to,
            from: "support@autohubexpress.us", 
            replyTo: "support@autohubexpress.us", 
            subject: formattedSubject,
            trackingSettings: {
                clickTracking: {
                    enable: false,
                    enableText: false
                }
            },
            html: safeMessage
                .split("\n")
                .map(line => `<p style="margin: 0 0 10px;">${line}</p>`)
                .join("") + emailSignature,
            attachments: sgAttachments
        });

        // 2. Save reply in CRM database
        const savedReply = await CRMEmail.create({
            sender_email: "support@autohubexpress.us",
            subject: formattedSubject,
            body: safeMessage,
            attachments: crmAttachments,
            status: "read",
            thread_id: emailOnly,
        });

        // 3. Emit real-time socket event
        const io = req.app.get("io");
        if (io) {
            io.emit("new_email", {
                email: savedReply,
                unread: false,
            });
        }

        return res.json({ success: true });

    } catch (err) {
        console.error("SEND ERROR:", err.response?.body || err);
        return res.status(500).json({ error: "Failed to send email" });
    } finally {
        // ALWAYS cleans up uploaded files, preventing server disk fills
        filesToCleanup.forEach(file => {
            if (file.path) {
                fs.unlink(file.path, (err) => {
                    if (err) console.error("Temp file deletion failed:", err);
                });
            }
        });
    }
};

const forwardEmail = async (req, res) => {
    const filesToCleanup = req.files || [];

    try {
        const to = req.body.to;
        const message = req.body.message;

        let originalEmail = {};
        try {
            originalEmail = typeof req.body.originalEmail === "string"
                ? JSON.parse(req.body.originalEmail)
                : req.body.originalEmail || {};
        } catch (err) {
            console.error("originalEmail parse error:", err);
        }

        // Email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!to || !emailRegex.test(to)) {
            return res.status(400).json({ error: "Invalid forward email destination" });
        }

        // Process attachments safely
        const sgAttachments = filesToCleanup.map(file => {
            const attachment = {
                filename: file.originalname,
                type: file.mimetype,
                disposition: "attachment",
            };
            if (file.path) {
                attachment.content = fs.readFileSync(file.path).toString("base64");
            }
            return attachment;
        });

        const crmAttachments = filesToCleanup.map(file => ({
            filename: file.originalname,
            url: `${process.env.BASE_URL}/uploads/${file.filename}`
        }));

        console.log("FORWARD ATTACHMENTS:", sgAttachments); // debug

        // Clean forward subject by shiva
        const cleanSubject = (originalEmail?.subject || "")
            .replace(/^Fwd\[\d+\]\s*/i, "")
            .replace(/^(Fwd:\s*)+/i, "")
            .trim();

        const formattedForwardSubject = `Fwd[${getForwardCount(originalEmail?.subject || "")}] ${cleanSubject}`;

        // 1. Send via SendGrid
        await sgMail.send({
            to,
            from: "support@autohubexpress.us",
            replyTo: "support@autohubexpress.us",
            subject: formattedForwardSubject,
            attachments: sgAttachments,
            trackingSettings: {
                clickTracking: {
                    enable: false,
                    enableText: false
                }
            },
            html: `
                <div style="font-family: Arial;">
                    ${message ? `<p>${message}</p>` : ""}
                    <hr />
                    <h3>Forwarded Message</h3>
                    <p><strong>From:</strong> ${originalEmail?.sender_email || ""}</p>
                    <p><strong>Subject:</strong> ${originalEmail?.subject || ""}</p>
                    <div style="
                        margin-top: 10px;
                        padding: 12px;
                        background: #f1f5f9;
                        border-radius: 6px;
                        color: #000;
                    ">
                        ${originalEmail?.body ? String(originalEmail.body) : ""}
                    </div>
                </div>
                ${emailSignature}
            `,
        });

        // 2. Save forwarded email record in database
        const savedForward = await CRMEmail.create({
            sender_email: "support@autohubexpress.us",
            subject: formattedForwardSubject,
            body: `Forwarded To: ${to}\n\n${message || ""}`,
            attachments: crmAttachments,
            status: "read",
            thread_id: originalEmail?.thread_id || to,
        });

        // 3. Emit real-time socket event
        const io = req.app.get("io");
        if (io) {
            io.emit("new_email", {
                email: savedForward,
                unread: false,
            });
        }

        return res.json({ success: true });

    } catch (err) {
        console.error("FORWARD ERROR:", err.response?.body || err);
        return res.status(500).json({ error: "Failed to forward email" });
    } finally {
        // ALWAYS cleans up uploaded files, preventing server disk fills
        filesToCleanup.forEach(file => {
            if (file.path) {
                fs.unlink(file.path, (err) => {
                    if (err) console.error("Temp file deletion failed:", err);
                });
            }
        });
    }
};

module.exports = {
    sendReply,
    forwardEmail
};