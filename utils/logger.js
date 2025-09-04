const fs = require("fs");
const path = require("path");

// Ensure logs directory exists
const logsDir = path.join(__dirname, "..", "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Log levels
const LOG_LEVELS = {
  ERROR: "ERROR",
  WARN: "WARN",
  INFO: "INFO",
  DEBUG: "DEBUG",
};

// Colors for console output
const colors = {
  ERROR: "\x1b[31m", // Red
  WARN: "\x1b[33m", // Yellow
  INFO: "\x1b[36m", // Cyan
  DEBUG: "\x1b[90m", // Gray
  RESET: "\x1b[0m", // Reset
};

class Logger {
  constructor() {
    this.isDevelopment = process.env.NODE_ENV === "development";
  }

  formatMessage(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaStr =
      Object.keys(meta).length > 0 ? ` | ${JSON.stringify(meta)}` : "";
    return `[${timestamp}] [${level}] ${message}${metaStr}`;
  }

  writeToFile(filename, message) {
    if (process.env.NODE_ENV === "production") {
      const filePath = path.join(logsDir, filename);
      fs.appendFileSync(filePath, message + "\n");
    }
  }

  log(level, message, meta = {}) {
    const formattedMessage = this.formatMessage(level, message, meta);

    // Console output with colors in development
    if (this.isDevelopment) {
      const color = colors[level] || colors.RESET;
      console.log(`${color}${formattedMessage}${colors.RESET}`);
    }

    // File output in production
    switch (level) {
      case LOG_LEVELS.ERROR:
        this.writeToFile("error.log", formattedMessage);
        if (!this.isDevelopment) console.error(formattedMessage);
        break;
      case LOG_LEVELS.WARN:
        this.writeToFile("app.log", formattedMessage);
        break;
      case LOG_LEVELS.INFO:
        this.writeToFile("app.log", formattedMessage);
        break;
      case LOG_LEVELS.DEBUG:
        if (this.isDevelopment) {
          this.writeToFile("debug.log", formattedMessage);
        }
        break;
    }
  }

  error(message, meta = {}) {
    this.log(LOG_LEVELS.ERROR, message, meta);
  }

  warn(message, meta = {}) {
    this.log(LOG_LEVELS.WARN, message, meta);
  }

  info(message, meta = {}) {
    this.log(LOG_LEVELS.INFO, message, meta);
  }

  debug(message, meta = {}) {
    this.log(LOG_LEVELS.DEBUG, message, meta);
  }

  // Database operation logging
  dbOperation(operation, collection, data = {}) {
    this.info(`DB Operation: ${operation}`, {
      collection,
      ...data,
    });
  }

  // Authentication logging
  auth(action, user, details = {}) {
    this.info(`Auth: ${action}`, {
      userId: user?._id || "Unknown",
      email: user?.email || "Unknown",
      ...details,
    });
  }

  // API request logging
  apiRequest(method, url, user, statusCode, responseTime) {
    this.info(`API Request`, {
      method,
      url,
      userId: user?._id || "Anonymous",
      statusCode,
      responseTime: `${responseTime}ms`,
    });
  }
}

module.exports = new Logger();
