// Middleware to add user context for logging
const addUserContext = (req, res, next) => {
  // This middleware should be used after auth middleware
  // It helps with logging by ensuring user info is available

  const originalJson = res.json;
  const originalSend = res.send;

  // Override res.json to add timing
  res.json = function (data) {
    res.locals.responseData = data;
    return originalJson.call(this, data);
  };

  // Override res.send to add timing
  res.send = function (data) {
    res.locals.responseData = data;
    return originalSend.call(this, data);
  };

  next();
};

module.exports = addUserContext;
