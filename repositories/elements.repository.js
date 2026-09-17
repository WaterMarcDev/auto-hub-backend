const BaseRepository = require("./base.repository");
const Element = require("../models/elements.model");

class ElementsRepository extends BaseRepository {
  constructor() {
    super(Element);
  }
}

module.exports = new ElementsRepository();
