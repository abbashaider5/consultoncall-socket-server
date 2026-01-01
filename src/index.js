/**
 * ConsultOnCall Socket Server
 * Handles real-time calling and WebRTC signaling
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { initializeSocket } = require('./socket');
const HeartbeatManager = require('./heartbeat');
const logger = require('./utils/logger');

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  const rooms = require('./rooms');
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    stats: rooms.getStats()
  });
});

// Get active calls (for backend sync)
app.get('/active-calls', (req, res) => {
  const rooms = require('./rooms');
  const activeCalls = rooms.getAllActiveCalls();
  res.json({
    success: true,
    activeCalls,
    count: activeCalls.length
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'ConsultOnCall Socket Server',
    version: '1.0.0',
    status: 'running'
  });
});

// Initialize Socket.IO
const io = initializeSocket(server);

// Initialize Heartbeat System (CRITICAL FOR STATE SYNC)
const heartbeat = new HeartbeatManager(io);
heartbeat.start();
logger.info('Heartbeat system initialized');

// Start server
const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  logger.info(`Socket server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`Client URL: ${process.env.CLIENT_URL || '*'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, closing server...');
  heartbeat.stop();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, closing server...');
  heartbeat.stop();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});
