const BaseRepository = require("./base.repository");
const PaymentSlip = require("../models/paymentSlip.model");

class PaymentSlipRepository extends BaseRepository {
  constructor() {
    super(PaymentSlip);
  }
}

module.exports = new PaymentSlipRepository();
