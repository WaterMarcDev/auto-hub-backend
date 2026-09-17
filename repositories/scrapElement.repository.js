const BaseRepository = require("./base.repository");
const ScrapElement = require("../models/scrapElements.model");

class ScrapElementRepository extends BaseRepository {
  constructor() {
    super(ScrapElement);
  }
}

module.exports = new ScrapElementRepository();
