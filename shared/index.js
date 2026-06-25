module.exports = {
  connectDB: require("./database"),
  authMiddleware: require("./auth.middleware"),
  errorHandler: require("./errorHandler"),
};
