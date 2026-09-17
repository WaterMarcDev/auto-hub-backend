const BaseRepository = require("./base.repository");
const ElementHub = require("../models/elementHub.model");

class ElementHubRepository extends BaseRepository {
  constructor() {
    super(ElementHub);
  }
}

module.exports = new ElementHubRepository();
