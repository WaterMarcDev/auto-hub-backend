/**
 * Send/Forward Email business logic. Extracted 1:1 from
 * controllers/sendEmail.controller.js during the clean-architecture
 * migration — every regex, subject-formatting rule, attachment-loading
 * path, and SendGrid payload shape is preserved exactly.
 */
const sgMail = require("@sendgrid/mail");
const fs = require("fs");
const path = require("path");
const emailSignature = require("../utils/emailSignature");
const crmEmailRepository = require("../repositories/crmEmail.repository");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Reply count
function getReplyCount(subject) {
  subject = subject || "";

  const match = subject.match(/^Re\[(\d+)\]/);
  if (match) return parseInt(match[1], 10) + 1;

  const count = (subject.match(/Re:/g) || []).length;
  if (count > 0) return count + 1;

  return 1;
}

// Normalize a cc field that may arrive as a single string, a comma/semicolon
// separated string, or an array (multer/express turn repeated form fields of
// the same name into an array) into a flat list of trimmed, non-empty strings.
function parseCcList(rawCc) {
  if (!rawCc) return [];

  const arr = Array.isArray(rawCc) ? rawCc : [rawCc];

  return arr
    .flatMap((v) => String(v).split(/[,;]/))
    .map((v) => v.trim())
    .filter(Boolean);
}

// Forward count
function getForwardCount(subject) {
  subject = subject || "";

  const match = subject.match(/^Fwd\[(\d+)\]/);
  if (match) return parseInt(match[1], 10) + 1;

  const count = (subject.match(/Fwd:/g) || []).length;
  if (count > 0) return count + 1;

  return 1;
}

// No contentType is stored on attachment metadata, so infer it from the
// extension for the small set of types this app actually handles.
const EXT_TO_MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
};

function mimeFromFilename(filename) {
  return EXT_TO_MIME[path.extname(filename).toLowerCase()] || "application/octet-stream";
}

const UPLOADS_DIR = path.join(__dirname, "..", "uploads");

// Re-attach the ORIGINAL email's already-stored attachments during forward.
// originalEmail (parsed from the frontend's payload) already carries the
// original CRMEmail document, including its attachments array — forwardEmail
// previously only read subject/sender_email/body from it and dropped the
// attachments entirely. Reads straight from local disk (same storage the
// incoming-attachment fix uses) rather than fetching the stored URL.
function loadOriginalAttachments(originalEmail) {
  const originalAttachments = Array.isArray(originalEmail?.attachments) ? originalEmail.attachments : [];

  const sg = [];
  const crm = [];

  for (const att of originalAttachments) {
    // path.basename strips any directory traversal component; the
    // startsWith check below is defense in depth on top of that.
    const safeName = path.basename(att?.filename || "");

    if (!safeName) continue;

    const filePath = path.join(UPLOADS_DIR, safeName);

    if (!filePath.startsWith(UPLOADS_DIR)) continue;

    try {
      const content = fs.readFileSync(filePath).toString("base64");

      sg.push({
        content,
        filename: att.originalname || safeName,
        type: mimeFromFilename(safeName),
        disposition: "attachment",
      });

      crm.push({
        filename: safeName,
        originalname: att.originalname || safeName,
        url: att.url,
      });
    } catch (err) {
      console.error("Original attachment unavailable for forward:", safeName, err.message);
    }
  }

  return { sg, crm };
}

function validationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sendReply(body, files) {
  const { to, cc, subject, message } = body;

  const raw = to || "";
  const emailOnly = raw.match(/<(.+)>/)?.[1] || raw;

  if (!EMAIL_REGEX.test(emailOnly)) {
    throw validationError("Invalid recipient email");
  }

  const rawCcList = parseCcList(cc);
  const invalidCc = rawCcList.filter((addr) => !EMAIL_REGEX.test(addr));

  if (invalidCc.length) {
    throw validationError(`Invalid CC email: ${invalidCc.join(", ")}`);
  }

  const ccList = [...new Set(rawCcList)].filter((addr) => addr.toLowerCase() !== emailOnly.toLowerCase());

  const safeSubject = subject || "No Subject";
  const safeMessage = message || "";

  const sgAttachments = (files || []).map((file) => ({
    content: fs.readFileSync(file.path).toString("base64"),
    filename: file.originalname,
    type: file.mimetype,
    disposition: "attachment",
  }));

  const crmAttachments = (files || []).map((file) => ({
    filename: file.filename,
    originalname: file.originalname,
    url: `${process.env.BASE_URL}/uploads/${file.filename}`,
  }));

  const count = getReplyCount(safeSubject);

  const cleanSubject = safeSubject
    .replace(/^Re\[\d+\]\s*/i, "")
    .replace(/^(Re:\s*)+/i, "")
    .trim();

  const formattedSubject = `Re[${count}] ${cleanSubject}`;

  await sgMail.send({
    to: emailOnly,
    ...(ccList.length ? { cc: ccList } : {}),
    from: "support@autohubexpress.us",
    replyTo: "support@autohubexpress.us",
    subject: formattedSubject,
    attachments: sgAttachments,
    trackingSettings: { clickTracking: { enable: false, enableText: false } },
    html: `
                <div style="font-family: Arial, sans-serif;">
                    ${safeMessage}

                    <br /><br />

                    ${emailSignature}
                </div>
            `,
  });

  return crmEmailRepository.create({
    sender_email: "support@autohubexpress.us",
    subject: formattedSubject,
    body: safeMessage,
    cc: ccList,
    attachments: crmAttachments,
    status: "replied", // read
    thread_id: emailOnly,
  });
}

async function forwardEmail(body, files) {
  const rawTo = body.to || "";
  const to = rawTo.match(/<(.+)>/)?.[1] || rawTo;
  const message = body.message || "";

  let originalEmail = {};
  try {
    originalEmail = typeof body.originalEmail === "string" ? JSON.parse(body.originalEmail) : body.originalEmail || {};
  } catch (err) {
    console.error("originalEmail parse error:", err);
  }

  if (!EMAIL_REGEX.test(to)) {
    throw validationError("Invalid forward email");
  }

  const newSgAttachments = (files || []).map((file) => ({
    content: fs.readFileSync(file.path).toString("base64"),
    filename: file.originalname,
    type: file.mimetype,
    disposition: "attachment",
  }));

  const newCrmAttachments = (files || []).map((file) => ({
    filename: file.filename,
    originalname: file.originalname,
    url: `${process.env.BASE_URL}/uploads/${file.filename}`,
  }));

  const originalAttachments = loadOriginalAttachments(originalEmail);

  const sgAttachments = [...originalAttachments.sg, ...newSgAttachments];
  const crmAttachments = [...originalAttachments.crm, ...newCrmAttachments];

  const cleanSubject = (originalEmail?.subject || "")
    .replace(/^Fwd\[\d+\]\s*/i, "")
    .replace(/^(Fwd:\s*)+/i, "")
    .trim();

  const formattedForwardSubject = `Fwd[${getForwardCount(originalEmail?.subject || "")}] ${cleanSubject}`;

  await sgMail.send({
    to,
    from: "support@autohubexpress.us",
    replyTo: "support@autohubexpress.us",
    subject: formattedForwardSubject,
    attachments: sgAttachments,
    trackingSettings: { clickTracking: { enable: false, enableText: false } },
    html: `
    <div style="font-family: Arial;">

        ${message ? `<p>${message}</p>` : ""}

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
                        ${originalEmail?.body ? String(originalEmail.body) : ""}
                    </div>

                </div>

    ${emailSignature}
`,
  });

  return crmEmailRepository.create({
    sender_email: "support@autohubexpress.us",
    subject: formattedForwardSubject,
    body: `
Forwarded To:
${to}

${message}
`,
    attachments: crmAttachments,
    status: "read",
    thread_id: originalEmail?.thread_id || to,
  });
}

module.exports = {
  sendReply,
  forwardEmail,
};
