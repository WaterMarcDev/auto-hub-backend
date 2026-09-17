const BaseRepository = require("./base.repository");
const Make = require("../models/make.model");

class MakeRepository extends BaseRepository {
  constructor() {
    super(Make);
  }
}

module.exports = new MakeRepository();
