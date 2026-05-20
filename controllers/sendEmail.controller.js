console.log("API KEY:", process.env.SENDGRID_API_KEY);
console.log(
    "BASE URL:",
    process.env.BASE_URL
);  // debug for BASE_URL
const CRMEmail = require("../models/CRMEmail.model");
const sgMail = require("@sendgrid/mail");
const fs = require("fs");                                    // added by shiva
const emailSignature = require("../utils/emailSignature");   // Added by shiva

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Reply count by shiva
function getReplyCount(subject) {
    // Case 1: already in Re[n]
    const match = subject.match(/^Re\[(\d+)\]/);
    if (match) return parseInt(match[1]) + 1;

    // Case 2: old "Re: Re: Re:"
    const count = (subject.match(/Re:/g) || []).length;
    if (count > 0) return count + 1;

    // First reply
    return 1;
}
// end here

// Forward count by shiva
function getForwardCount(subject) {

    // Case 1: already Fwd[n]
    const match =
        subject.match(/^Fwd\[(\d+)\]/);

    if (match)
        return parseInt(match[1]) + 1;

    // Case 2: old Fwd: Fwd:
    const count =
        (subject.match(/Fwd:/g) || []).length;

    if (count > 0)
        return count + 1;

    // First forward
    return 1;
}
// end here

const sendReply = async (req, res) => {
    try {
        const { to, subject, message } = req.body;

        // Attachment by shiva
        const attachments =
            (req.files || []).map(file => ({

                content: require("fs")
                    .readFileSync(file.path)
                    .toString("base64"),

                filename: file.originalname,

                type: file.mimetype,

                disposition: "attachment",

                url:
                    `${process.env.BASE_URL}/uploads/${file.filename}`
            }));

        // const attachments =
        //     (req.files || []).map(file => ({

        //         content: file.buffer.toString("base64"),
        //         filename: file.originalname,
        //         type: file.mimetype,
        //         disposition: "attachment",
        //         content_id: file.originalname
        //     }));
        // end here

        const count = getReplyCount(subject);    // Reply count
        const formattedSubject = `Re[${count}]`;

        await sgMail.send({
            to,
            from: "support@autohubexpress.us",    //must be verified in SendGrid
            replyTo: "support@mail.autohubexpress.us",
            subject: formattedSubject,
            html: message
                .split("\n")
                .map(line => `<p style="margin: 0 0 10px;">${line}</p>`)
                .join("") + emailSignature,    // added emailSignature

            attachments  // added by shiva
        });

        // save reply in DB
        const raw = to;
        const emailOnly = raw.match(/<(.+)>/)?.[1] || raw;

        await CRMEmail.create({
            sender_email:
                "support@autohubexpress.us",

            subject:
                formattedSubject,

            body:
                message,

            attachments:
                attachments.map(file => ({
                    filename: file.filename,
                    url: file.url
                })),

            status:
                "read",

            thread_id:
                emailOnly,
        });

        res.json({ success: true });
    } catch (err) {
        console.error("SEND ERROR:", err);
        res.status(500).json({ error: "Failed to send email" });
    }
};

// Forward Email by shiva
const forwardEmail = async (req, res) => {

    try {

        const to = req.body.to;

        const message = req.body.message;


        let originalEmail = {};

        try {

            originalEmail =
                typeof req.body.originalEmail === "string"
                    ? JSON.parse(req.body.originalEmail)
                    : req.body.originalEmail;

        } catch (err) {

            console.error(
                "originalEmail parse error:",
                err
            );
        }

        // const originalEmail =
        //     typeof req.body.originalEmail === "string"
        //         ? JSON.parse(req.body.originalEmail)
        //         : req.body.originalEmail;

        // const {
        //     to,
        //     message,
        //     originalEmail
        // } = req.body;

        // Attachments for forward mails by shiva
        const attachments =
            (req.files || []).map(file => ({

                content:
                    fs.readFileSync(file.path)
                        .toString("base64"),

                filename:
                    file.originalname,

                type:
                    file.mimetype,

                disposition:
                    "attachment",

                url:
                    `${process.env.BASE_URL}/uploads/${file.filename}`
            }));

        console.log("FORWARD ATTACHMENTS:", attachments);   // debug




        // const attachments =
        //     (req.files || []).map(file => ({
        //         content: file.buffer.toString("base64"),
        //         filename: file.originalname,
        //         type: file.mimetype,
        //         disposition: "attachment"
        //     }));
        // end here

        // Clean forward subject by shiva
        const cleanSubject =
            (originalEmail?.subject || "")
                .replace(/^Fwd\[\d+\]\s*/i, "")
                .replace(/^(Fwd:\s*)+/i, "")
                .trim();

        const formattedForwardSubject =
            `Fwd[${getForwardCount(
                originalEmail?.subject || ""
            )
            }] ${cleanSubject}`;
        // end here

        // Email validation by shiva
        const emailRegex =
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!emailRegex.test(to)) {

            return res.status(400).json({
                error: "Invalid email"
            });
        }

        await sgMail.send({

            to,
            from: "support@autohubexpress.us",
            replyTo: "support@mail.autohubexpress.us",
            subject: formattedForwardSubject,
            attachments,   // added by shiva

            html: `
                    <div style="font-family: Arial;">

                        <p>
                            ${message
                    ? `
                                <p>
                                    ${message}
                                </p>
                            `
                    : ""
                }
                        </p>

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
                            margin-top: 10px;
                            padding: 12px;
                            background: #f1f5f9;
                            border-radius: 6px;
                            color: #000;
                        ">
                            ${originalEmail?.body
                    ? String(originalEmail.body)
                    : ""
                }
                        </div>

                    </div>
                    ${emailSignature}
                `,
        });

        // Save forwarded mail in CRM by shiva
        // Save forwarded mail in CRM by shiva
        const savedForward =
            await CRMEmail.create({

                sender_email:
                    "support@autohubexpress.us",

                subject:
                    formattedForwardSubject,

                body: `
                    Forwarded To:
                    ${to}

                    ${message || ""}
                `,

                attachments:
                    attachments.map(file => ({
                        filename: file.filename,
                        url: file.url
                    })),
                // Attachments:
                //     ${
                //         attachments
                //             .map(file => `📎 ${file.filename}|||${file.url}`)
                //             .join("\n")
                //     }
                // `
                //         : ""
                //     }
                // `,

                status: "read",

                thread_id:
                originalEmail?.thread_id,
            });

    // Real time emit by shiva
    const io = req.app.get("io");

    if (io) {

        io.emit("new_email", {
            email: savedForward,
            unread: false,
        });
    }
    // end here
    // end here

    res.json({
        success: true
    });

} catch (err) {

    console.error(
        "FORWARD ERROR:",
        err
    );

    res.status(500).json({
        error:
            "Failed to forward email"
    });
}
};
// end here

module.exports = {
    sendReply,
    forwardEmail
};