const BaseRepository = require("./base.repository");
const Conversation = require("../models/conversation.model");

class ConversationRepository extends BaseRepository {
  constructor() {
    super(Conversation);
  }
}

module.exports = new ConversationRepository();
