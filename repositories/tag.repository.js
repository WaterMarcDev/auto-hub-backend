const BaseRepository = require("./base.repository");
const Tag = require("../models/tag.model");

class TagRepository extends BaseRepository {
  constructor() {
    super(Tag);
  }
}

module.exports = new TagRepository();
