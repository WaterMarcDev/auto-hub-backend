const formatBarcode = (number, digits) => {
    const padded = String(number).padStart(digits, "0");
    return `AUT${padded}`;
};

module.exports = { formatBarcode };
