const BaseRepository = require("./base.repository");
const Transaction = require("../models/transaction.model");

class TransactionRepository extends BaseRepository {
  constructor() {
    super(Transaction);
  }

  build(data) {
    return new Transaction(data);
  }
}

module.exports = new TransactionRepository();
