const BaseRepository = require("./base.repository");
const Inventory = require("../models/inventory.model");

class InventoryRepository extends BaseRepository {
  constructor() {
    super(Inventory);
  }
}

module.exports = new InventoryRepository();
