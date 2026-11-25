/**
 * Password rules for user accounts (create user, reset password, register).
 * Mirrors auto-hub-frontend/src/utils/password.js.
 *
 * Max 64 characters: passwords are hashed with bcrypt, which only uses the
 * first 72 bytes, so anything longer would silently not be checked at login.
 */
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 64;

// Error message for a new password, or null when it is valid.
function passwordError(password) {
  if (typeof password !== "string" || password.length === 0) return "Password is required";
  if (!password.trim()) return "Password cannot be only spaces";
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password can be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  // bcrypt's real limit is 72 bytes (accented / non-Latin characters use more than one).
  if (Buffer.byteLength(password, "utf8") > 72) return "Password is too long";
  return null;
}

module.exports = { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, passwordError };
