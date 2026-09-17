const BaseRepository = require("./base.repository");
const Customer = require("../models/customer.model");

class CustomerRepository extends BaseRepository {
  constructor() {
    super(Customer);
  }

  /** Preserves the original controller's `new Customer(...); .save()`
   * construction pattern exactly (as opposed to `.create()`), since that
   * is what the pre-refactor code did. */
  build(data) {
    return new Customer(data);
  }
}

module.exports = new CustomerRepository();
