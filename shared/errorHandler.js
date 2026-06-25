/**
 * Central error handler middleware — attach as the last middleware in each service.
 */
const errorHandler = (err, req, res, next) => {
  console.error(`Error ${err.status || 500}: ${err.message}`);
  console.error(`Request: ${req.method} ${req.url}`);
  console.error(`User: ${req.user ? req.user._id : "Anonymous"}`);
  console.error(err.stack);

  const isDevelopment = process.env.NODE_ENV === "development";

  res.status(err.status || 500).json({
    error: err.message || "Something went wrong!",
    ...(isDevelopment && { stack: err.stack }),
    timestamp: new Date().toISOString(),
  });
};

const notFound = (req, res) => {
  res.status(404).json({ error: "Route not found" });
};

module.exports = { errorHandler, notFound };
