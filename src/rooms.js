/**
 * In-memory storage for socket connections and active calls
 */

const logger = require('./utils/logger');

class RoomManager {
  constructor() {
    // userId -> socketId mapping
    this.userSockets = new Map();

    // expertId -> socketId mapping
    this.expertSockets = new Map();

    // socketId -> { userId, userType } mapping
    this.socketToUser = new Map();

    // callId -> { userId, expertId, userSocketId, expertSocketId, status, startTime } mapping
    this.activeCalls = new Map();

    // expertId -> Set of online experts
    this.onlineExperts = new Set();
  }

  // Register user socket connection
  registerUser(userId, socketId) {
    this.userSockets.set(userId, socketId);
    this.socketToUser.set(socketId, { userId, userType: 'user' });
    logger.info('User registered', { userId, socketId });
  }

  // Register expert socket connection
  registerExpert(expertId, socketId) {
    this.expertSockets.set(expertId, socketId);
    this.socketToUser.set(socketId, { userId: expertId, userType: 'expert' });
    this.onlineExperts.add(expertId);
    logger.info('Expert registered', { expertId, socketId });
  }

  // Get user socket ID
  getUserSocket(userId) {
    return this.userSockets.get(userId);
  }

  // Get expert socket ID
  getExpertSocket(expertId) {
    return this.expertSockets.get(expertId);
  }

  // Check if expert is online
  isExpertOnline(expertId) {
    return this.onlineExperts.has(expertId) && this.expertSockets.has(expertId);
  }

  // Check if expert is in active call
  isExpertBusy(expertId) {
    const expertCalls = [];
    for (const [callId, call] of this.activeCalls) {
      if (call.expertId === expertId) {
        expertCalls.push({ callId, status: call.status });
        // Only consider expert busy if call is ringing or connected
        if (call.status === 'ringing' || call.status === 'connected') {
          return true;
        }
      }
    }
    return false;
  }

  // Get expert's active calls
  getExpertActiveCalls(expertId) {
    const calls = [];
    for (const [callId, call] of this.activeCalls) {
      if (call.expertId === expertId) {
        calls.push({ callId, status: call.status, userId: call.userId });
      }
    }
    return calls;
  }

  // Create a new call
  createCall(callId, userId, expertId, userSocketId, expertSocketId, callerInfo = null) {
    const call = {
      callId,
      userId,
      expertId,
      userSocketId,
      expertSocketId,
      callerInfo,
      status: 'ringing',
      createdAt: Date.now(),
      startTime: null
    };
    this.activeCalls.set(callId, call);
    logger.callEvent('call_created', call);
    return call;
  }

  // Get call by ID
  getCall(callId) {
    return this.activeCalls.get(callId);
  }

  // Update call status
  updateCallStatus(callId, status) {
    const call = this.activeCalls.get(callId);
    if (call) {
      call.status = status;
      if (status === 'connected' && !call.startTime) {
        call.startTime = Date.now();
      }
      logger.callEvent('call_status_updated', { callId, status });
    }
    return call;
  }

  // Update heartbeat for call participant
  updateHeartbeat(callId, userId, userType) {
    const call = this.activeCalls.get(callId);
    if (call) {
      if (userType === 'user' || call.userId === userId) {
        call.lastUserHeartbeat = Date.now();
      } else if (userType === 'expert' || call.expertId === userId) {
        call.lastExpertHeartbeat = Date.now();
      }
      // logger.debug(`Heartbeat updated for ${userId} in call ${callId}`);
    }
  }

  // End call and remove from active calls
  endCall(callId) {
    const call = this.activeCalls.get(callId);
    if (call) {
      this.activeCalls.delete(callId);
      logger.callEvent('call_ended', { callId });
    }
    return call;
  }

  // Get call duration in seconds
  getCallDuration(callId) {
    const call = this.activeCalls.get(callId);
    if (call && call.startTime) {
      return Math.floor((Date.now() - call.startTime) / 1000);
    }
    return 0;
  }

  // Remove socket and cleanup
  removeSocket(socketId) {
    const userData = this.socketToUser.get(socketId);

    if (userData) {
      const { userId, userType } = userData;

      if (userType === 'user') {
        this.userSockets.delete(userId);
      } else if (userType === 'expert') {
        this.expertSockets.delete(userId);
      }

      this.socketToUser.delete(socketId);

      // Clean up any active calls for this user
      for (const [callId, call] of this.activeCalls) {
        if (call.userSocketId === socketId || call.expertSocketId === socketId) {
          this.activeCalls.delete(callId);
          logger.callEvent('call_cleaned_on_disconnect', { callId, socketId });
        }
      }

      logger.disconnection(socketId, userId);
    }

    return userData;
  }

  // Get all online expert IDs
  getOnlineExperts() {
    return Array.from(this.onlineExperts);
  }

  // Get all online expert IDs (alias for heartbeat)
  getAllOnlineExperts() {
    return this.getOnlineExperts();
  }

  // Get all active calls
  getAllActiveCalls() {
    const calls = [];
    for (const [callId, call] of this.activeCalls) {
      calls.push({
        callId,
        ...call
      });
    }
    return calls;
  }

  // Get statistics
  getStats() {
    return {
      totalUsers: this.userSockets.size,
      totalExperts: this.expertSockets.size,
      onlineExperts: this.onlineExperts.size,
      activeCalls: this.activeCalls.size
    };
  }
}

module.exports = new RoomManager();
