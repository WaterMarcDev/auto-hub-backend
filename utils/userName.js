/**
 * First / last name checks for CRM user accounts (Users > Add / Edit and
 * POST /api/auth/register). Mirrors the rules on the Add User form.
 */
const MAX_USER_NAME_LENGTH = 50;

// Trimmed name with inner runs of spaces collapsed ("  John   Paul " -> "John Paul").
const cleanName = (value) =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value;

// Error message for a name, or null when it is valid. `label` is e.g. "First name".
function userNameError(value, label) {
  if (value === undefined || value === null || typeof value !== "string" || !value.trim()) {
    return `${label} is required and cannot be only spaces.`;
  }
  if (cleanName(value).length > MAX_USER_NAME_LENGTH) {
    return `${label} can be at most ${MAX_USER_NAME_LENGTH} characters.`;
  }
  return null;
}

// Turns a Mongoose ValidationError into a readable 400 message (or null).
function validationMessage(error) {
  if (!error || error.name !== "ValidationError" || !error.errors) return null;
  return Object.values(error.errors)
    .map((e) => e.message)
    .join(" ");
}

module.exports = { MAX_USER_NAME_LENGTH, cleanName, userNameError, validationMessage };
