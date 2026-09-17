const BaseRepository = require("./base.repository");
const CarModel = require("../models/model.model");

class ModelRepository extends BaseRepository {
  constructor() {
    super(CarModel);
  }
}

module.exports = new ModelRepository();
