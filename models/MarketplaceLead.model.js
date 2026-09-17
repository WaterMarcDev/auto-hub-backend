/**
 * @deprecated Renamed to models/MarketplaceListing.model.js (this module now
 * represents Marketplace Listings, not "leads"). This file is kept as a
 * backward-compatible re-export so any existing require() of the old path
 * keeps working — new code should require "./MarketplaceListing.model"
 * directly.
 */
module.exports = require("./marketplaceListing.model");
