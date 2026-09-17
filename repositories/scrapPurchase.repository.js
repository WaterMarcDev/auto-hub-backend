const BaseRepository = require("./base.repository");
const ScrapPurchase = require("../models/scrapPurchase.model");

class ScrapPurchaseRepository extends BaseRepository {
  constructor() {
    super(ScrapPurchase);
  }
}

module.exports = new ScrapPurchaseRepository();
