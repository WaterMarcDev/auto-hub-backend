const BaseRepository = require("./base.repository");
const Seller = require("../models/seller.model");

class SellerRepository extends BaseRepository {
  constructor() {
    super(Seller);
  }

  build(data) {
    return new Seller(data);
  }
}

module.exports = new SellerRepository();
