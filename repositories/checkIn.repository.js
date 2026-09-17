const BaseRepository = require("./base.repository");
const CheckIn = require("../models/checkIn.model");

class CheckInRepository extends BaseRepository {
  constructor() {
    super(CheckIn);
  }

  build(data) {
    return new CheckIn(data);
  }
}

module.exports = new CheckInRepository();
