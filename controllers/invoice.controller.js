const invoiceService = require("../services/invoice.service");

const printInvoice = async (req, res) => {
  try {
    const viewData = await invoiceService.getInvoiceForPrint(req.params.id);
    return res.render("invoice.njk", viewData);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).send("Invoice not found");
    console.error("Print invoice error:", err);
    return res.status(500).json({ error: "Server error rendering invoice" });
  }
};

module.exports = { printInvoice };
