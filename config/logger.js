const morgan = require("morgan");
const fs = require("fs");
const path = require("path");

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, "..", "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Create write streams for different log files
const accessLogStream = fs.createWriteStream(path.join(logsDir, "access.log"), {
  flags: "a",
});

const errorLogStream = fs.createWriteStream(path.join(logsDir, "error.log"), {
  flags: "a",
});

// Custom token for request body (sanitized)
morgan.token("body", (req) => {
  if (req.body && typeof req.body === "object") {
    const sanitized = { ...req.body };
    // Hide sensitive fields
    const sensitiveFields = ["password", "token", "secret"];
    sensitiveFields.forEach((field) => {
      if (sanitized[field]) sanitized[field] = "[HIDDEN]";
    });
    return JSON.stringify(sanitized);
  }
  return "";
});

// Custom token for user info (if authenticated)
morgan.token("user", (req) => {
  return req.user ? `User:${req.user._id}` : "Anonymous";
});

// Custom token for timestamp
morgan.token("timestamp", () => {
  return new Date().toISOString();
});

// Development format
const devFormat =
  ":timestamp :method :url :status :res[content-length] - :response-time ms :user :body";

// Production format
const prodFormat =
  ":timestamp :remote-addr :method :url :status :res[content-length] - :response-time ms :user-agent";

// Error format
const errorFormat =
  ":timestamp :method :url :status :res[content-length] - :response-time ms :user :body";

const loggerConfig = {
  // Development logging
  development: morgan(devFormat, {
    stream: process.stdout,
    skip: (req, res) => {
      // Skip logging for health checks and static assets
      return req.url === "/api/health" || req.url.includes("/static/");
    },
  }),

  // Production access logging
  production: morgan(prodFormat, {
    stream: accessLogStream,
    skip: (req, res) => res.statusCode >= 400, // Only log successful requests to access.log
  }),

  // Error logging (for both dev and prod)
  error: morgan(errorFormat, {
    stream:
      process.env.NODE_ENV === "production" ? errorLogStream : process.stderr,
    skip: (req, res) => res.statusCode < 400, // Only log errors
  }),
};

module.exports = loggerConfig;
