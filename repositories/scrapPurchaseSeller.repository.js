const BaseRepository = require("./base.repository");
const ScrapPurchaseSeller = require("../models/scrapPurchaseSeller.model");

class ScrapPurchaseSellerRepository extends BaseRepository {
  constructor() {
    super(ScrapPurchaseSeller);
  }
}

module.exports = new ScrapPurchaseSellerRepository();
