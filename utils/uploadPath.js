const path = require("path");

const UPLOADS_DIR = path.resolve(__dirname, "../uploads");

/**
 * Resolves a client-supplied filename to an absolute path directly inside
 * uploads/, or returns null. Rejects path separators, "..", and dotfiles so
 * inputs like "..%2Fserver.js" or "/uploads/../.env" can't escape the
 * uploads directory.
 */
const resolveUploadPath = (filename) => {
  if (!filename || filename !== path.basename(filename) || filename.startsWith(".")) {
    return null;
  }
  const filePath = path.resolve(UPLOADS_DIR, filename);
  return path.dirname(filePath) === UPLOADS_DIR ? filePath : null;
};

module.exports = { UPLOADS_DIR, resolveUploadPath };
