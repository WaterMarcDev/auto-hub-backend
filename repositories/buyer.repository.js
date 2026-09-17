const BaseRepository = require("./base.repository");
const Buyer = require("../models/buyer.model");

class BuyerRepository extends BaseRepository {
  constructor() {
    super(Buyer);
  }

  build(data) {
    return new Buyer(data);
  }
}

module.exports = new BuyerRepository();
