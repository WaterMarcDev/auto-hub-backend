const BaseRepository = require("./base.repository");
const BackInStockRequest = require("../models/backInStockRequest.model");

class BackInStockRequestRepository extends BaseRepository {
  constructor() {
    super(BackInStockRequest);
  }
}

module.exports = new BackInStockRequestRepository();
