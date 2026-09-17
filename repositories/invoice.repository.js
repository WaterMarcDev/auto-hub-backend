const BaseRepository = require("./base.repository");
const Invoice = require("../models/invoice.model");

class InvoiceRepository extends BaseRepository {
  constructor() {
    super(Invoice);
  }

  /** Passthrough to the model's custom static factory (Invoice.createFrom). */
  createFrom(data) {
    return Invoice.createFrom(data);
  }
}

module.exports = new InvoiceRepository();
