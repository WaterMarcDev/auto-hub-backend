const BaseRepository = require("./base.repository");
const Waiver = require("../models/waiver.model");

class WaiverRepository extends BaseRepository {
  constructor() {
    super(Waiver);
  }

  build(data) {
    return new Waiver(data);
  }
}

module.exports = new WaiverRepository();
