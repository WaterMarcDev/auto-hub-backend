const BaseRepository = require("./base.repository");
const CarIntake = require("../models/carIntake.model");

// Minimal repository covering what services/vin.service.js needs. The full
// CarIntake domain (controllers/carIntakeController.js, ~2100 lines) is
// migrated separately — this class extends BaseRepository only, so any
// additional domain-specific query methods that migration needs can be
// added here later without conflicting with or duplicating this file.
class CarIntakeRepository extends BaseRepository {
  constructor() {
    super(CarIntake);
  }

  build(data) {
    return new CarIntake(data);
  }
}

module.exports = new CarIntakeRepository();
