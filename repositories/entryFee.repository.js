const BaseRepository = require("./base.repository");
const EntryFee = require("../models/entryFee.model");

class EntryFeeRepository extends BaseRepository {
  constructor() {
    super(EntryFee);
  }
}

module.exports = new EntryFeeRepository();
