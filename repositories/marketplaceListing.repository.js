const BaseRepository = require("./base.repository");
const MarketplaceListing = require("../models/marketplaceListing.model");

class MarketplaceListingRepository extends BaseRepository {
  constructor() {
    super(MarketplaceListing);
  }
}

module.exports = new MarketplaceListingRepository();
