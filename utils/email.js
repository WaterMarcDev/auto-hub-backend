/**
 * Email check: name@domain.tld, where the domain has at least one dot and
 * the ending (.com, .net, .co.uk ...) is a real top-level domain from the
 * IANA list (so "name@site.cooim" is rejected). Also rejects spaces, a
 * missing @ or domain, double dots and leading / trailing dots or dashes.
 * Mirrors auto-hub-frontend/src/utils/email.js.
 */
const { EMAIL_TLDS } = require("./emailTlds");

const EMAIL_REGEX =
  /^(?!\.)(?!.*\.\.)[A-Za-z0-9._%+-]+(?<!\.)@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

// The ending after the last dot, lower-cased ("com" for name@mail.example.com).
const emailTld = (email) => email.slice(email.lastIndexOf(".") + 1).toLowerCase();

// Error message for an email, or null when it is valid.
function emailError(value) {
  const email = typeof value === "string" ? value.trim() : "";
  if (!email || email.length > 254 || !EMAIL_REGEX.test(email)) {
    return "Please enter a valid email address.";
  }
  const tld = emailTld(email);
  if (!EMAIL_TLDS.has(tld)) {
    return `".${tld}" is not a real email domain ending.`;
  }
  return null;
}

const isValidEmail = (value) => emailError(value) === null;

module.exports = { EMAIL_REGEX, emailError, isValidEmail };
