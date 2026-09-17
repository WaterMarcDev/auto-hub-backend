const BaseRepository = require("./base.repository");
const JunkCar = require("../models/junkCar.model");

class JunkCarRepository extends BaseRepository {
  constructor() {
    super(JunkCar);
  }
}

module.exports = new JunkCarRepository();
