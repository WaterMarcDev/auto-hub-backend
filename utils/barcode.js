const formatBarcode = (number, digits) => {
    return String(number).padStart(digits, "0");
};

module.exports = { formatBarcode };
