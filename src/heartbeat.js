/**
 * Heartbeat System - Ensures DB and Socket State Stay in Sync
 * THIS IS CRITICAL: Prevents experts from staying BUSY forever
 */

const axios = require('axios');
const logger = require('./utils/logger');
const rooms = require('./rooms');

const API_BASE_URL = process.env.API_BASE_URL || 'https://api.abbaslogic.com';
const HEARTBEAT_INTERVAL = 15000; // 15 seconds

class HeartbeatManager {
  constructor(io) {
    this.io = io;
    this.intervalId = null;
  }

  start() {
    logger.info('Starting heartbeat system...');
    
    // Run immediately
    this.performSync();
    
    // Then run periodically
    this.intervalId = setInterval(() => {
      this.performSync();
    }, HEARTBEAT_INTERVAL);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Heartbeat system stopped');
    }
  }

  async performSync() {
    try {
      // Get all active socket connections
      const onlineExperts = rooms.getAllOnlineExperts();
      const activeCalls = rooms.getAllActiveCalls();

      logger.info(`Heartbeat: ${onlineExperts.length} experts online, ${activeCalls.length} active calls`);

      // Sync with backend
      await this.syncExpertStatus(onlineExperts);
      await this.syncActiveCalls(activeCalls);

    } catch (error) {
      logger.error('Heartbeat sync error:', error);
    }
  }

  async syncExpertStatus(onlineExperts) {
    try {
      // Send list of actually online experts to backend for monitoring
      const response = await axios.post(`${API_BASE_URL}/api/experts/sync-online-status`, {
        onlineExpertIds: onlineExperts,
        timestamp: Date.now()
      }, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 5000
      });

      // Log any discrepancies found (but don't auto-correct)
      if (response.data.discrepancies && response.data.discrepancies > 0) {
        logger.info(`Heartbeat: Found ${response.data.discrepancies} experts with status discrepancies (not auto-corrected)`);
      }

    } catch (error) {
      logger.error('Failed to sync expert status:', error.message);
    }
  }

  async syncActiveCalls(activeCalls) {
    try {
      // Send list of actually active calls to backend
      const callIds = activeCalls.map(call => call.callId).filter(Boolean);
      
      if (callIds.length === 0) {
        return;
      }

      const response = await axios.post(`${API_BASE_URL}/api/calls/sync-active-calls`, {
        activeCallIds: callIds,
        timestamp: Date.now()
      }, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 5000
      });

      if (response.data.cleanedCalls && response.data.cleanedCalls.length > 0) {
        logger.info(`Heartbeat cleaned ${response.data.cleanedCalls.length} stale calls`);
        
        // Clean up local state for cleaned calls
        response.data.cleanedCalls.forEach(callId => {
          rooms.endCall(callId);
        });
      }

    } catch (error) {
      logger.error('Failed to sync active calls:', error.message);
    }
  }
}

module.exports = HeartbeatManager;
