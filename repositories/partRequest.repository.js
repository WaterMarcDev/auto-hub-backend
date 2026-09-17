const BaseRepository = require("./base.repository");
const PartRequest = require("../models/partRequest.model");

class PartRequestRepository extends BaseRepository {
  constructor() {
    super(PartRequest);
  }

  build(data) {
    return new PartRequest(data);
  }
}

module.exports = new PartRequestRepository();
