/**
 * BaseRepository — the ONLY layer in this codebase that is meant to hold a
 * direct reference to a Mongoose Model. Every domain repository extends
 * this and wraps ONE model, so services (and controllers) never import a
 * model directly and never call Mongoose methods directly.
 *
 * This is a thin, faithful pass-through of Mongoose's own method
 * signatures — NOT a redesigned/opinionated data-access API. That is a
 * deliberate choice for this migration: the goal is to introduce the
 * repository/service/controller layering without changing any existing
 * query behavior (including any pre-existing quirks), since every
 * endpoint that works today must keep working identically.
 */
class BaseRepository {
  constructor(model) {
    this.model = model;
  }

  create(data) {
    return this.model.create(data);
  }

  insertMany(docs, options) {
    return this.model.insertMany(docs, options);
  }

  findById(id, projection, options) {
    return this.model.findById(id, projection, options);
  }

  findOne(filter, projection, options) {
    return this.model.findOne(filter, projection, options);
  }

  find(filter, projection, options) {
    return this.model.find(filter, projection, options);
  }

  countDocuments(filter) {
    return this.model.countDocuments(filter);
  }

  findByIdAndUpdate(id, update, options) {
    return this.model.findByIdAndUpdate(id, update, options);
  }

  findOneAndUpdate(filter, update, options) {
    return this.model.findOneAndUpdate(filter, update, options);
  }

  updateOne(filter, update, options) {
    return this.model.updateOne(filter, update, options);
  }

  updateMany(filter, update, options) {
    return this.model.updateMany(filter, update, options);
  }

  findByIdAndDelete(id, options) {
    return this.model.findByIdAndDelete(id, options);
  }

  findOneAndDelete(filter, options) {
    return this.model.findOneAndDelete(filter, options);
  }

  deleteOne(filter) {
    return this.model.deleteOne(filter);
  }

  deleteMany(filter) {
    return this.model.deleteMany(filter);
  }

  aggregate(pipeline) {
    return this.model.aggregate(pipeline);
  }

  exists(filter) {
    return this.model.exists(filter);
  }

  distinct(field, filter) {
    return this.model.distinct(field, filter);
  }

  /** Saves an already-fetched Mongoose document instance (preserves
   * validators/hooks exactly as the original fetch-mutate-save() pattern
   * did before this migration). */
  save(doc) {
    return doc.save();
  }

  /** Escape hatch for anything not covered above, without ever letting
   * calling code import the Mongoose model directly. Use sparingly. */
  raw() {
    return this.model;
  }
}

module.exports = BaseRepository;
