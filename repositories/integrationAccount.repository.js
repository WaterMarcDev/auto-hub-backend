const BaseRepository = require("./base.repository");
const IntegrationAccount = require("../models/integrationAccount.model");

class IntegrationAccountRepository extends BaseRepository {
  constructor() {
    super(IntegrationAccount);
  }
}

module.exports = new IntegrationAccountRepository();
