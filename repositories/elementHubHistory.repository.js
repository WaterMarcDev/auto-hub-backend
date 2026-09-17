const BaseRepository = require("./base.repository");
const ElementHubHistory = require("../models/elementHubHistory.model");

class ElementHubHistoryRepository extends BaseRepository {
  constructor() {
    super(ElementHubHistory);
  }
}

module.exports = new ElementHubHistoryRepository();
