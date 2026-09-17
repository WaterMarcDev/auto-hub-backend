const BaseRepository = require("./base.repository");
const Part = require("../models/part.model");

class PartRepository extends BaseRepository {
  constructor() {
    super(Part);
  }
}

module.exports = new PartRepository();
