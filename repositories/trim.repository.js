const BaseRepository = require("./base.repository");
const Trim = require("../models/trim.model");

class TrimRepository extends BaseRepository {
  constructor() {
    super(Trim);
  }
}

module.exports = new TrimRepository();
