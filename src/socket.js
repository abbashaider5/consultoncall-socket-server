/**
 * Socket.IO setup and configuration
 */

const { Server } = require('socket.io');
const EventHandler = require('./events');
const logger = require('./utils/logger');

function parseAllowedOrigins() {
  const raw = process.env.CLIENT_URLS || process.env.CLIENT_URL || '';
  const defaults = ['https://abbaslogic.com', 'https://www.abbaslogic.com'];
  const list = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const allow = [...new Set([...defaults, ...list])];
  return allow;
}

function initializeSocket(server) {
  const allowedOrigins = parseAllowedOrigins();

  const io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        // Allow non-browser clients (no Origin header)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`CORS blocked origin: ${origin}`));
      },
      methods: ['GET', 'POST', 'OPTIONS'],
      credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    connectTimeout: 45000
  });

  const eventHandler = new EventHandler(io);

  // Global interval to check for stale calls (no heartbeat > 15s)
  // Run frequent checks (every 5s) for high safety
  if (!server._heartbeatInterval) {
    server._heartbeatInterval = setInterval(() => {
      const rooms = require('./rooms');
      const now = Date.now();
      const HEARTBEAT_TIMEOUT = 15000; // 15 seconds

      for (const [callId, call] of rooms.activeCalls) {
        if (call.status === 'connected') {
          const timeSinceUserHeartbeat = now - (call.lastUserHeartbeat || call.startTime);
          const timeSinceExpertHeartbeat = now - (call.lastExpertHeartbeat || call.startTime);

          // Check User
          if (timeSinceUserHeartbeat > HEARTBEAT_TIMEOUT) {
            logger.warn(`🚨 Call ${callId} auto-cut: User heartbeat lost (>15s)`);
            // Force end call using the eventHandler instance
            // We use a mock socket object or direct method if refactored
            // Here we trigger it directly via eventHandler's logic
            eventHandler.handleCallEnd(
              { id: 'system_autocut' }, // Mock socket
              { callId },
              () => logger.info(`Auto-cut completed for call ${callId}`)
            );
          }
        }
      }
    }, 5000);
  }

  // Heartbeat mechanism for expert status sync
  setInterval(async () => {
    // Clean up stale expert connections
    const rooms = require('./rooms');
    const now = Date.now();

    for (const [expertId, socketId] of rooms.expertSockets) {
      const socket = io.sockets.sockets.get(socketId);
      if (!socket || !socket.connected) {
        logger.warn(`🧹 Cleaning up stale expert connection: ${expertId}`);
        rooms.onlineExperts.delete(expertId);
        rooms.expertSockets.delete(expertId);
        rooms.socketToUser.delete(socketId);
      }
    }

    // Sync busy statuses - clear busy for experts with no active calls
    try {
      const axios = require('axios');
      const BACKEND_URL = process.env.BACKEND_URL || 'https://api.abbaslogic.com';

      // Get all experts marked as busy
      const busyExpertsResponse = await axios.get(`${BACKEND_URL}/api/experts?limit=1000`);
      const experts = busyExpertsResponse.data.experts || [];

      for (const expert of experts) {
        if (expert.isBusy) {
          // Check if this expert has any active calls
          const activeCalls = rooms.getExpertActiveCalls(expert._id);
          if (activeCalls.length === 0) {
            // No active calls, clear busy status
            logger.info(`🔄 Auto-clearing busy status for expert ${expert._id} (no active calls)`);
            await axios.put(`${BACKEND_URL}/api/experts/set-online-internal/${expert._id}`, { isBusy: false });

            // Emit to all clients
            io.emit('expert_busy_changed', { expertId: expert._id, isBusy: false });
          }
        }
      }
    } catch (error) {
      logger.error('Error in busy status sync:', error.message);
    }
  }, 30000); // Every 30 seconds

  io.on('connection', (socket) => {
    logger.connection(socket.id, 'unknown', 'connected');

    // Registration events
    socket.on('register', (data) => {
      eventHandler.handleRegister(socket, data);
    });

    // Call events - support both old and new event names
    socket.on('call_request', (data, callback) => {
      eventHandler.handleCallRequest(socket, data, callback);
    });

    socket.on('call:initiate', (data, callback) => {
      eventHandler.handleCallRequest(socket, data, callback);
    });

    socket.on('accept_call', (data, callback) => {
      eventHandler.handleAcceptCall(socket, data, callback);
    });

    socket.on('call:accept', (data, callback) => {
      eventHandler.handleAcceptCall(socket, data, callback);
    });

    socket.on('reject_call', (data, callback) => {
      eventHandler.handleRejectCall(socket, data, callback);
    });

    socket.on('call:reject', (data, callback) => {
      eventHandler.handleRejectCall(socket, data, callback);
    });

    socket.on('call_connected', (data, callback) => {
      eventHandler.handleCallConnected(socket, data, callback);
    });

    socket.on('call:connected', (data, callback) => {
      eventHandler.handleCallConnected(socket, data, callback);
    });

    socket.on('end_call', (data, callback) => {
      eventHandler.handleCallEnd(socket, data, callback);
    });

    socket.on('call:end', (data, callback) => {
      eventHandler.handleCallEnd(socket, data, callback);
    });

    // Chat events
    socket.on('send_message', (data, callback) => {
      eventHandler.handleSendMessage(socket, data, callback);
    });

    socket.on('typing', (data) => {
      eventHandler.handleTyping(socket, data);
    });

    socket.on('message_read', (data) => {
      eventHandler.handleMessageRead(socket, data);
    });

    // Cleanup
    socket.on('disconnect', () => {
      eventHandler.handleDisconnect(socket);
    });
  });

  // Log stats every 60 seconds in development
  if (process.env.NODE_ENV !== 'production') {
    setInterval(() => {
      const rooms = require('./rooms');
      logger.info('Server stats', rooms.getStats());
    }, 60000);
  }

  return io;
}

module.exports = { initializeSocket };
