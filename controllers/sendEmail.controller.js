console.log("API KEY:", process.env.SENDGRID_API_KEY);
console.log("BASE URL:", process.env.BASE_URL);

const CRMEmail = require("../models/CRMEmail.model");
const sgMail = require("@sendgrid/mail");
const fs = require("fs");
const emailSignature = require("../utils/emailSignature");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Reply count
function getReplyCount(subject) {

    subject = subject || "";

    const match = subject.match(/^Re\[(\d+)\]/);

    if (match)
        return parseInt(match[1], 10) + 1;

    const count =
        (subject.match(/Re:/g) || []).length;

    if (count > 0)
        return count + 1;

    return 1;
}

// Forward count
function getForwardCount(subject) {

    subject = subject || "";

    const match =
        subject.match(/^Fwd\[(\d+)\]/);

    if (match)
        return parseInt(match[1], 10) + 1;

    const count =
        (subject.match(/Fwd:/g) || []).length;

    if (count > 0)
        return count + 1;

    return 1;
}

// SEND REPLY
const sendReply = async (req, res) => {

    try {

        const {
            to,
            subject,
            message
        } = req.body;

        // Extract pure email safely
        const raw = to || "";

        const emailOnly =
            raw.match(/<(.+)>/)?.[1] || raw;

        // Email validation
        const emailRegex =
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!emailRegex.test(emailOnly)) {

            return res.status(400).json({
                error: "Invalid recipient email"
            });
        }

        const safeSubject =
            subject || "No Subject";

        const safeMessage =
            message || "";

        // SENDGRID attachments
        const sgAttachments =
            (req.files || []).map(file => ({

                content:
                    fs.readFileSync(file.path)
                        .toString("base64"),

                filename:
                    file.originalname,

                type:
                    file.mimetype,

                disposition:
                    "attachment"
            }));

        // CRM attachments
        const crmAttachments =
            (req.files || []).map(file => ({

                filename:
                    file.filename,
                
                    originalname:
                        file.originalname,

                url:
                    `${process.env.BASE_URL}/uploads/${file.filename}`
            }));

        const count =
            getReplyCount(safeSubject);

        const cleanSubject =
            safeSubject
                .replace(/^Re\[\d+\]\s*/i, "")
                .replace(/^(Re:\s*)+/i, "")
                .trim();

        const formattedSubject =
            `Re[${count}] ${cleanSubject}`;

        // SEND EMAIL
        await sgMail.send({

            to: emailOnly,

            from:
                "support@autohubexpress.us",

            replyTo:
                "support@autohubexpress.us",

            subject:
                formattedSubject,

            trackingSettings: {
                clickTracking: {
                    enable: false,
                    enableText: false
                }
            },

            html: `
                <div style="font-family: Arial, sans-serif;">
                    ${safeMessage}
                </div>
            `,
                // "<h1>Test Reply</h1>",
        });

        // SAVE IN DB
        const savedReply =
            await CRMEmail.create({

                sender_email:
                    "support@autohubexpress.us",

                subject:
                    formattedSubject,

                body:
                    safeMessage,

                attachments:
                    crmAttachments,

                status:
                    "read",

                thread_id:
                    emailOnly,
            });

        // SOCKET EMIT
        const io =
            req.app.get("io");

        if (io) {

            io.emit("new_email", {

                email:
                    savedReply,

                unread:
                    false,
            });
        }

        res.json({
            success: true,
            data: savedReply
        });

    } catch (err) {

        console.error("========== SEND REPLY ERROR ==========");

        console.error("MESSAGE:");
        console.error(err.message);

        console.error("STACK:");
        console.error(err.stack);

        console.log(
            JSON.stringify(
                err.response?.body,
                null,
                2
            )
        );
        console.error(err.response?.body);

        console.error("FULL ERROR:");
        console.error(err);
        
        
        
        // console.error(
        //     "SEND ERROR:",
        //     err.response?.body || err
        // );

        res.status(500).json({
            error: err.message || "Failed to send email"
        });
    }
};

// FORWARD EMAIL
const forwardEmail = async (req, res) => {

    try {

        // Extract clean email
        const rawTo =
            req.body.to || "";

        const to =
            rawTo.match(/<(.+)>/)?.[1] || rawTo;

        const message =
            req.body.message || "";

        let originalEmail = {};

        try {

            originalEmail =
                typeof req.body.originalEmail === "string"
                    ? JSON.parse(req.body.originalEmail)
                    : req.body.originalEmail || {};

        } catch (err) {

            console.error(
                "originalEmail parse error:",
                err
            );
        }

        // Email validation
        const emailRegex =
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!emailRegex.test(to)) {

            return res.status(400).json({
                error:
                    "Invalid forward email"
            });
        }

        // SENDGRID attachments
        const sgAttachments =
            (req.files || []).map(file => ({

                content:
                    fs.readFileSync(file.path)
                        .toString("base64"),

                filename:
                    file.originalname,

                type:
                    file.mimetype,

                disposition:
                    "attachment"
            }));

        // CRM attachments
        const crmAttachments =
            (req.files || []).map(file => ({

                filename:
                    file.filename,
                
                    originalname:
                        file.originalname,

                url:
                    `${process.env.BASE_URL}/uploads/${file.filename}`
            }));

        // Clean subject
        const cleanSubject =
            (originalEmail?.subject || "")
                .replace(/^Fwd\[\d+\]\s*/i, "")
                .replace(/^(Fwd:\s*)+/i, "")
                .trim();

        const formattedForwardSubject =
            `Fwd[${getForwardCount(
                originalEmail?.subject || ""
            )}] ${cleanSubject}`;

        // SEND EMAIL
        await sgMail.send({

            to,

            from:
                "support@autohubexpress.us",

            replyTo:
                "support@autohubexpress.us",

            subject:
                formattedForwardSubject,

            attachments:
                sgAttachments,

            trackingSettings: {
                clickTracking: {
                    enable: false,
                    enableText: false
                }
            },

            html: `
    <div style="font-family: Arial;">

        ${
    message
        ? `<p>${message}</p>`
        : ""
}

                    <hr />

                    <h3>
                        Forwarded Message
                    </h3>

                    <p>
                        <strong>From:</strong>
                        ${originalEmail?.sender_email || ""}
                    </p>

                    <p>
                        <strong>Subject:</strong>
                        ${originalEmail?.subject || ""}
                    </p>

                    <div style="
                        margin-top:10px;
                        padding:12px;
                        background:#f1f5f9;
                        border-radius:6px;
                        color:#000;
                    ">
                        ${
                            originalEmail?.body
                                ? String(originalEmail.body)
                                : ""
                        }
                    </div>

                </div>

    ${ emailSignature }
`,
        });

        // SAVE IN DB
        const savedForward =
            await CRMEmail.create({

                sender_email:
                    "support@autohubexpress.us",

                subject:
                    formattedForwardSubject,

                body: `
Forwarded To:
${to}

${message}
`,

                attachments:
                    crmAttachments,

                status:
                    "read",

                thread_id:
                    originalEmail?.thread_id || to,
            });

        // SOCKET EMIT
        const io =
            req.app.get("io");

        if (io) {

            io.emit("new_email", {

                email:
                    savedForward,

                unread:
                    false,
            });
        }

        res.json({
            success: true,
            data: savedForward
        });

    } catch (err) {

        console.error("========== FORWARD ERROR ==========");

        console.error("MESSAGE:");
        console.error(err.message);

        console.error("STACK:");
        console.error(err.stack);

        console.error("SENDGRID:");
        console.error(err.response?.body);

        console.error("FULL ERROR:");
        console.error(err);
        
        
        // console.error(
        //     "FORWARD ERROR:",
        //     err.response?.body || err
        // );

        res.status(500).json({
            error: err.message || "Failed to forward email"
        });
    }
};

module.exports = {
    sendReply,
    forwardEmail
};
