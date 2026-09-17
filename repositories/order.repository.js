const BaseRepository = require("./base.repository");
const Order = require("../models/order.model");

class OrderRepository extends BaseRepository {
  constructor() {
    super(Order);
  }
}

module.exports = new OrderRepository();
