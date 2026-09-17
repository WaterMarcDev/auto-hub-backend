const BaseRepository = require("./base.repository");
const User = require("../models/user.model");

// Shared by services/auth.service.js and services/user.service.js — both
// controllers operated on the same User model before this migration.
class UserRepository extends BaseRepository {
  constructor() {
    super(User);
  }
}

module.exports = new UserRepository();
