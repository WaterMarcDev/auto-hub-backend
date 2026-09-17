const BaseRepository = require("./base.repository");
const EbaySyncRun = require("../models/ebaySyncRun.model");

class EbaySyncRunRepository extends BaseRepository {
  constructor() {
    super(EbaySyncRun);
  }

  /** Passthrough to the model's own static helpers — these are custom
   * domain statics (Mongo-backed locking), not generic Mongoose CRUD, so
   * BaseRepository has no generic equivalent for them. */
  acquireLock(trigger) {
    return this.model.acquireLock(trigger);
  }

  releaseLock(run, status, summary) {
    return this.model.releaseLock(run, status, summary);
  }

  getLatestRun() {
    return this.model.getLatestRun();
  }
}

module.exports = new EbaySyncRunRepository();
