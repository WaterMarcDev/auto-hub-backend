// Asset tag format: "AUT" + the tag number zero-padded to 6 digits
// (e.g. 123 -> "AUT000123"). Every generated tag uses this one format so
// printed labels and scanned codes always look the same.
const TAG_PREFIX = "AUT";
const TAG_DIGITS = 6;
const MAX_TAG_NUMBER = 10 ** TAG_DIGITS - 1; // 999999, the largest number that fits
const MAX_TAGS_PER_BATCH = 1000; // largest range that can be generated in one go

const formatBarcode = (number, digits = TAG_DIGITS) => {
    const padded = String(number).padStart(digits, "0");
    return `${TAG_PREFIX}${padded}`;
};

// Reads a tag number from "123", "000123" or "AUT000123" (any case).
// Returns NaN when the text is not a tag code.
const parseBarcode = (value) => {
    const match = /^(?:AUT)?(\d+)$/i.exec(String(value ?? "").trim());
    return match ? Number(match[1]) : NaN;
};

module.exports = {
    TAG_PREFIX,
    TAG_DIGITS,
    MAX_TAG_NUMBER,
    MAX_TAGS_PER_BATCH,
    formatBarcode,
    parseBarcode,
};
