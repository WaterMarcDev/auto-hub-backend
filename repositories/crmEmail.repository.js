const BaseRepository = require("./base.repository");
const CRMEmail = require("../models/crmEmail.model");

class CrmEmailRepository extends BaseRepository {
  constructor() {
    super(CRMEmail);
  }
}

module.exports = new CrmEmailRepository();
