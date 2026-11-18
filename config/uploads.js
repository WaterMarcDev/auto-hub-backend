const path = require("path");
const fs = require("fs");

// Folder where uploaded files (car intake photos, Excel imports, email
// attachments) are stored on disk.
//
// Set UPLOAD_DIR to keep uploads outside the app folder, e.g. on Azure App
// Service use /home/data/uploads: a deploy replaces the app folder, which
// would otherwise delete every uploaded file. When UPLOAD_DIR is not set the
// default is <backend>/uploads, exactly as before.
//
// Only the location on disk changes. Files are still served at /uploads/<file>,
// so stored URLs do not change.
const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads")
);

// Create the folder on startup. If it can't be created (wrong path or no
// permission), log the problem and keep the server running: only uploads
// will fail, not the whole API.
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
} catch (err) {
  console.error(
    `[UPLOADS] Could not create upload folder "${UPLOAD_DIR}" — file uploads will fail until this is fixed:`,
    err.message
  );
}

module.exports = { UPLOAD_DIR };
