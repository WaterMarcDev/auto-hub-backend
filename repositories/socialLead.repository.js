const BaseRepository = require("./base.repository");
const SocialLead = require("../models/socialLead.model");

class SocialLeadRepository extends BaseRepository {
  constructor() {
    super(SocialLead);
  }
}

module.exports = new SocialLeadRepository();
