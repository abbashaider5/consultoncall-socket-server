/**
 * Logger utility for consistent logging
 */

class Logger {
  constructor() {
    this.context = '[SocketServer]';
  }

  info(message, data = {}) {
    console.log(`${this.context} INFO:`, message, data);
  }

  error(message, error = {}) {
    console.error(`${this.context} ERROR:`, message, error);
  }

  warn(message, data = {}) {
    console.warn(`${this.context} WARN:`, message, data);
  }

  debug(message, data = {}) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`${this.context} DEBUG:`, message, data);
    }
  }

  connection(socketId, userId, userType) {
    this.info(`User connected: ${socketId}`, { userId, userType });
  }

  disconnection(socketId, userId) {
    this.info(`User disconnected: ${socketId}`, { userId });
  }

  callEvent(event, data) {
    this.info(`Call event: ${event}`, data);
  }
}

module.exports = new Logger();
