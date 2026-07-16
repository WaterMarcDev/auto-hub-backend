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

        console.log("=== SEND REPLY DIAGNOSTIC ===");
        console.log("STEP 1: Request received");
        console.log("req.body.to:", req.body?.to);
        console.log("req.body.subject:", req.body?.subject);
        console.log("req.body.message length:", req.body?.message?.length);
        console.log("req.files count:", req.files?.length);
        console.log("SENDGRID_API_KEY present:", !!process.env.SENDGRID_API_KEY);
        console.log("SENDGRID_API_KEY prefix:", process.env.SENDGRID_API_KEY?.substring(0, 10));
        console.log("BASE_URL:", process.env.BASE_URL);
        console.log("BACKEND_URL:", process.env.BACKEND_URL);

        const {
            to,
            subject,
            message
        } = req.body;

        // Extract pure email safely
        const raw = to || "";

        const emailOnly =
            raw.match(/<(.+)>/)?.[1] || raw;

        console.log("STEP 2: Email parsed");
        console.log("raw:", raw);
        console.log("emailOnly:", emailOnly);

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

        console.log("STEP 3: Validation passed");
        console.log("safeSubject:", safeSubject);
        console.log("safeMessage length:", safeMessage.length);

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

        console.log("STEP 4: Files processed");
        console.log("sgAttachments count:", sgAttachments.length);

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

        console.log("STEP 5: Subject formatted");
        console.log("formattedSubject:", formattedSubject);

        // SEND EMAIL — include attachments so they are actually delivered
        const mailPayload = {

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

                    <br /><br />

                    ${emailSignature}
                </div>
            `,
        };

        if (sgAttachments.length > 0) {
            mailPayload.attachments = sgAttachments;
        }

        console.log("STEP 6: Calling sgMail.send()...");

        await sgMail.send(mailPayload);

        console.log("STEP 7: sgMail.send() succeeded");

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
                    "replied",     //read

                thread_id:
                    emailOnly,
            });

        console.log("STEP 8: CRMEmail.create() succeeded");
        console.log("savedReply._id:", savedReply._id);

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

        console.log("STEP 9: Returning success");
        console.log("=== END DIAGNOSTIC ===");

        res.json({
            success: true,
            data: savedReply
        });

    } catch (err) {

        console.error("========== SEND REPLY ERROR ==========");

        console.error("EXCEPTION TYPE:", err.constructor?.name);
        console.error("MESSAGE:", err.message);
        console.error("STACK:", err.stack);

        if (err.response?.body) {
            console.error("SENDGRID RESPONSE BODY:", JSON.stringify(err.response.body, null, 2));
            console.error("SENDGRID STATUS CODE:", err.code);
        }

        if (err.name === "ValidationError") {
            console.error("MONGOOSE VALIDATION ERROR:", JSON.stringify(err.errors, null, 2));
        }

        console.error("FULL ERROR:", err);

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
