// Shared helpers for free-text list searches.
//
// - The term is trimmed and runs of whitespace collapse to one space.
// - Regex metacharacters are escaped (no regex injection / no 500 on "(").
// - Whitespace in the term matches any run of whitespace in the data.
// - A "first last" term can be matched across separate firstName / lastName
//   fields (fullNameClauses), and a digits-only term matches phone numbers
//   stored with any formatting (phoneDigitsRegex).

const MAX_SEARCH_LENGTH = 100;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Trimmed, space-collapsed, length-capped search text ("" when blank).
const normalizeSearch = (raw) =>
  (raw == null ? "" : String(raw))
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_SEARCH_LENGTH)
    .trim();

// Escaped pattern source for a normalized term; spaces match any whitespace.
const termPattern = (term) => term.split(" ").map(escapeRegex).join("\\s+");

// Case-insensitive "contains" regex, or null for a blank term.
const containsRegex = (raw) => {
  const term = normalizeSearch(raw);
  return term ? new RegExp(termPattern(term), "i") : null;
};

// Phone match ignoring formatting, or null when the term does not look like a
// phone number (needs 3+ digits and only phone punctuation).
const phoneDigitsRegex = (raw) => {
  const term = normalizeSearch(raw);
  if (!/^[\d\s().+-]+$/.test(term)) return null;
  const digits = term.replace(/\D/g, "");
  if (digits.length < 3) return null;
  return new RegExp(digits.split("").join("\\D*"));
};

// Clauses matching a multi-word term split across a first-name and a
// last-name field: "John Smith" -> firstName ends with "John" AND lastName
// starts with "Smith" (every split point is tried, so "Mary Ann Lee" works
// for "Mary Ann" + "Lee" and "Mary" + "Ann Lee"). Empty for single words.
// Field names may be dotted paths, e.g. "seller.firstName".
const fullNameClauses = (raw, firstField = "firstName", lastField = "lastName") => {
  const term = normalizeSearch(raw);
  const words = term ? term.split(" ") : [];
  const clauses = [];
  for (let i = 1; i < words.length; i += 1) {
    clauses.push({
      [firstField]: new RegExp(`${termPattern(words.slice(0, i).join(" "))}\\s*$`, "i"),
      [lastField]: new RegExp(`^\\s*${termPattern(words.slice(i).join(" "))}`, "i"),
    });
  }
  return clauses;
};

// $or clauses for a person record with firstName / lastName / email / mobileNo
// (Customer, Seller, Buyer): contains-match on each field, "first last"
// across the two name fields, and phone digits in any format. Returns null
// for a blank term.
const personSearchClauses = (raw) => {
  const rx = containsRegex(raw);
  if (!rx) return null;
  const clauses = [
    { firstName: rx },
    { lastName: rx },
    { email: rx },
    { mobileNo: rx },
    ...fullNameClauses(raw),
  ];
  const phone = phoneDigitsRegex(raw);
  if (phone) clauses.push({ mobileNo: phone });
  return clauses;
};

module.exports = {
  MAX_SEARCH_LENGTH,
  escapeRegex,
  normalizeSearch,
  containsRegex,
  phoneDigitsRegex,
  fullNameClauses,
  personSearchClauses,
};
