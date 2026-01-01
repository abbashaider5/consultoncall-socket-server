/**
 * Socket event handlers
 * IMPORTANT: Socket server is a RELAY ONLY - Backend is source of truth
 */

const rooms = require('./rooms');
const logger = require('./utils/logger');
const axios = require('axios');

// Call timeout duration (60 seconds)
const CALL_TIMEOUT = 60000;

// Backend API URL
const BACKEND_URL = process.env.BACKEND_URL || 'https://api.abbaslogic.com';

class EventHandler {
  constructor(io) {
    this.io = io;
    this.callTimeouts = new Map();
  }

  // Handle user/expert registration
  async handleRegister(socket, data) {
    const { userId, userType } = data;

    if (!userId || !userType) {
      logger.error('Invalid registration data', data);
      return;
    }

    // Validate userType
    if (userType !== 'user' && userType !== 'expert') {
      logger.error('Invalid userType', { userType });
      return;
    }

    if (userType === 'expert') {
      // IMPORTANT: Expert online/offline is controlled ONLY by the expert toggle (DB source of truth).
      // On register we only attach the socket to the expert, but we do NOT change DB isOnline.
      rooms.userSockets.set(userId, socket.id);
      rooms.socketToUser.set(socket.id, { userId, userType: 'expert' });
      rooms.expertSockets.set(userId, socket.id);
      
      // JOIN EXPERT ROOM: Socket joins a room with their expert ID
      socket.join(userId);
      logger.info(`🎬 Expert joined room: ${userId}`);

      logger.info(`🔵 Expert socket registered: expertId=${userId}, socketId=${socket.id}`);
      logger.info(`🔵 Expert sockets map size: ${rooms.expertSockets.size}`);
      logger.info(`🔵 All registered experts:`, Array.from(rooms.expertSockets.keys()));

      // Inform clients of current DB status so UI doesn't drift
      try {
        const statusRes = await axios.get(`${BACKEND_URL}/api/experts/status/${userId}`);
        const isOnline = !!statusRes.data?.isOnline;
        let isBusy = !!statusRes.data?.isBusy;

        // If expert is marked busy but has no active calls, clear the busy status
        if (isBusy) {
          const activeCalls = rooms.getExpertActiveCalls(userId);
          if (activeCalls.length === 0) {
            // No active calls, clear busy status in DB
            try {
              await axios.put(`${BACKEND_URL}/api/experts/set-online-internal/${userId}`, { isOnline, isBusy: false });
              isBusy = false;
              logger.info(`Cleared stale busy status for expert ${userId}`);
            } catch (updateError) {
              logger.error(`Failed to clear busy status for ${userId}:`, updateError.message);
            }
          }
        }

        if (isOnline) {
          rooms.onlineExperts.add(userId);
        } else {
          rooms.onlineExperts.delete(userId);
        }

        this.io.emit('expert_status_changed', { expertId: userId, isOnline });
        this.io.emit('expert_busy_changed', { expertId: userId, isBusy });

        logger.info(`✅ Expert registered (dbOnline=${isOnline}, dbBusy=${isBusy}): ${userId}`);
      } catch (error) {
        logger.error(`Failed to read expert DB status for ${userId}:`, error.message);
        logger.info(`Expert registered (dbOnline=unknown, dbBusy=unknown): ${userId}`);
      }
    } else {
      rooms.registerUser(userId, socket.id);
      // JOIN USER ROOM
      socket.join(userId);
      logger.info(`🎬 User joined room: ${userId}`);
      logger.info(`User registered: ${userId}`);
    }

    socket.emit('registered', { success: true, userId, userType });
  }

  // Handle call request from user
  // NOTE: Backend already validated and created call record
  async handleCallRequest(socket, data, callback) {
    logger.info('📞 Call request received - RAW DATA:', JSON.stringify(data, null, 2));

    // userId may be missing from some clients; derive from registration map as a safe fallback
    const socketUser = rooms.socketToUser.get(socket.id);
    const derivedUserId = socketUser?.userType === 'user' ? socketUser.userId : undefined;
    const { callId, expertId } = data;
    const userId = data.userId || derivedUserId;

    logger.info('📞 Call request parsed', { callId, userId, expertId });

    if (!callId || !userId || !expertId) {
      logger.error('❌ Invalid call request data - MISSING FIELDS:', {
        hasCallId: !!callId,
        hasUserId: !!userId,
        hasExpertId: !!expertId,
        rawData: data
      });
      if (callback) callback({ success: false, error: 'Invalid call data' });
      return;
    }

    // Check expert status in database (primary check)
    let isExpertOnline = false;
    let isExpertBusyInDb = false;
    try {
      const response = await axios.get(`${BACKEND_URL}/api/experts/status/${expertId}`);
      isExpertOnline = response.data?.isOnline || false;
      isExpertBusyInDb = response.data?.isBusy || false;
      logger.info('🔍 Expert DB online check', { expertId, isOnline: isExpertOnline });
    } catch (error) {
      logger.error(`Failed to check expert DB status for ${expertId}:`, error.message);
      // Fallback to socket check if DB check fails
      isExpertOnline = rooms.isExpertOnline(expertId);
    }

    // Also check socket connection status
    const isExpertConnected = rooms.isExpertOnline(expertId);
    logger.info('🔍 Expert connection check', {
      expertId,
      dbOnline: isExpertOnline,
      socketConnected: isExpertConnected,
      onlineExperts: Array.from(rooms.onlineExperts)
    });

    if (!isExpertOnline) {
      logger.warn('❌ Expert not online in database', { expertId });
      if (callback) callback({ success: false, error: 'Expert is currently offline. Please try again later.' });
      return;
    }

    if (isExpertBusyInDb) {
      logger.warn('❌ Expert busy in database', { expertId });
      if (callback) callback({ success: false, error: 'Expert is currently on another call. Please try again later.' });
      return;
    }

    // If expert is online in DB but not connected to socket, they might be temporarily disconnected
    if (!isExpertConnected) {
      logger.warn('⚠️ Expert online in DB but not connected to socket - may be temporarily disconnected', { expertId });
      // Still allow the call since they're marked as online
    }

    // Check if expert is already in an active call
    const isExpertBusy = rooms.isExpertBusy(expertId);
    const expertActiveCalls = rooms.getExpertActiveCalls(expertId);
    logger.info('🔍 Expert busy check', {
      expertId,
      isExpertBusy,
      activeCalls: expertActiveCalls,
      totalActiveCalls: rooms.activeCalls.size
    });

    if (isExpertBusy) {
      logger.warn('❌ Expert is busy in another call', { expertId, activeCalls: expertActiveCalls });
      if (callback) callback({ success: false, error: 'Expert is currently on another call. Please try again later.' });
      return;
    }

    const expertSocketId = rooms.getExpertSocket(expertId);
    const userSocketId = socket.id;

    logger.info('🔍 Socket IDs', { expertId, expertSocketId, userSocketId });

    if (!expertSocketId) {
      // Expert is temporarily disconnected but online in DB
      logger.warn('⚠️ Expert socket not found - expert may be temporarily disconnected', { expertId });

      // Still create the call in backend and set to ringing
      // The expert will be notified when they reconnect
      try {
        await axios.put(`${BACKEND_URL}/api/calls/ringing/${callId}`, {}, {
          headers: {
            'Content-Type': 'application/json'
          }
        });
        logger.callEvent('call_set_ringing_disconnected_expert', { callId, expertId });

        // Set a timeout for the call (shorter since expert is disconnected)
        const timeout = setTimeout(() => {
          this.handleCallTimeout(callId);
        }, 15000); // 15 seconds instead of 30

        this.callTimeouts.set(callId, timeout);

        if (callback) callback({ success: true, callId, note: 'Expert temporarily disconnected - call will connect when they return' });
        logger.callEvent('✅ call_request_sent_disconnected_expert', { callId, userId, expertId });
        return;

      } catch (backendError) {
        logger.error('Failed to set call ringing for disconnected expert', backendError);
        if (callback) callback({ success: false, error: 'Backend error' });
        return;
      }
    }

    // Create call session in socket rooms
    const call = rooms.createCall(callId, userId, expertId, userSocketId, expertSocketId);

    // Update backend: set expert busy and call status to RINGING
    try {
      await axios.put(`${BACKEND_URL}/api/calls/ringing/${callId}`, {}, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      logger.callEvent('call_set_ringing', { callId });
    } catch (backendError) {
      logger.error('Failed to set call ringing in backend', backendError);

      // Cleanup on failure: remove from rooms and mark call as failed
      rooms.endCall(callId);

      // Notify user of failure
      if (callback) {
        const errorMsg = backendError.response?.data?.message || 'Failed to initiate call. Please try again.';
        callback({ success: false, error: errorMsg });
      }

      return;
    }

    // Fetch caller info for immediate display
    let callerInfo = null;
    try {
      const response = await axios.get(`${BACKEND_URL}/api/users/${userId}`, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      callerInfo = {
        name: response.data.name,
        avatar: response.data.avatar
      };
      logger.info('📋 Fetched caller info', { userId, name: callerInfo.name });
    } catch (error) {
      logger.warn('Failed to fetch caller info', { userId, error: error.message });
      callerInfo = { name: 'Unknown Caller', avatar: null };
    }

    // Send incoming call notification to expert
    logger.info('📤📤📤 SENDING INCOMING_CALL TO EXPERT', { 
      expertId, 
      expertSocketId, 
      callId, 
      userId,
      callerName: callerInfo?.name 
    });
    
    // Verify expert socket exists
    const expertSocket = this.io.sockets.sockets.get(expertSocketId);
    if (!expertSocket) {
      logger.error('❌ Expert socket not found in io.sockets.sockets!', { expertSocketId });
    } else {
      logger.info('✅ Expert socket found, connected:', expertSocket.connected);
    }
    
    const incomingCallPayload = {
      callId,
      userId,
      expertId,
      caller: callerInfo
    };
    
    logger.info('📤 Incoming call payload:', JSON.stringify(incomingCallPayload, null, 2));
    
    // Send to specific expert socket
    this.io.to(expertSocketId).emit('incoming_call', incomingCallPayload);
    
    // Also emit to expert's user ID room as backup
    this.io.to(expertId).emit('incoming_call', incomingCallPayload);
    
    logger.info('✅ incoming_call event emitted to expert');

    // Notify all clients that expert is now busy
    this.io.emit('expert_busy_changed', {
      expertId,
      isBusy: true
    });

    // Set timeout for call (30 seconds)
    const timeout = setTimeout(() => {
      const activeCall = rooms.getCall(callId);
      if (activeCall && activeCall.status === 'ringing') {
        // Call timed out - notify backend
        this.handleCallTimeout(callId);
      }
    }, CALL_TIMEOUT);

    this.callTimeouts.set(callId, timeout);

    if (callback) callback({ success: true, callId });
    logger.callEvent('✅ call_request_sent', { callId, userId, expertId });
  }

  // Handle call timeout
  async handleCallTimeout(callId) {
    try {
      const call = rooms.getCall(callId);
      if (!call) return;

      // Notify backend about timeout - mark call as MISSED
      try {
        await axios.put(`${BACKEND_URL}/api/calls/status/${callId}`, {
          status: 'missed'
        }, {
          headers: {
            'Content-Type': 'application/json'
          }
        });
        logger.callEvent('call_marked_missed', { callId });
      } catch (backendError) {
        logger.error('Failed to mark call as missed in backend', backendError);
      }

      // Notify user
      this.io.to(call.userSocketId).emit('call_timeout', { callId });

      // Notify all clients that expert is no longer busy
      this.io.emit('expert_busy_changed', {
        expertId: call.expertId,
        isBusy: false
      });

      // Clean up
      rooms.endCall(callId);
      this.callTimeouts.delete(callId);

      logger.callEvent('call_timeout', { callId });
    } catch (error) {
      logger.error('Handle call timeout error', error);
    }
  }

  // Handle expert accepting call
  // NOTE: Backend will handle state transition
  handleAcceptCall(socket, data, callback) {
    const { callId } = data;

    const call = rooms.getCall(callId);
    if (!call) {
      logger.error('Call not found', { callId });
      callback({ success: false, error: 'Call not found' });
      return;
    }

    // Clear timeout
    if (this.callTimeouts.has(callId)) {
      clearTimeout(this.callTimeouts.get(callId));
      this.callTimeouts.delete(callId);
    }

    // Update socket room status
    rooms.updateCallStatus(callId, 'accepted');

    // Notify user that call was accepted
    this.io.to(call.userSocketId).emit('call_accepted', {
      callId,
      expertId: call.expertId
    });

    callback({ success: true });
    logger.callEvent('call_accepted', { callId });
  }

  // Handle expert rejecting call
  // NOTE: Backend will handle state transition and expert release
  handleRejectCall(socket, data, callback) {
    const { callId, reason } = data;

    const call = rooms.getCall(callId);
    if (!call) {
      logger.error('Call not found', { callId });
      callback({ success: false, error: 'Call not found' });
      return;
    }

    // Clear timeout
    if (this.callTimeouts.has(callId)) {
      clearTimeout(this.callTimeouts.get(callId));
      this.callTimeouts.delete(callId);
    }

    // Remove call from socket rooms
    rooms.endCall(callId);

    // Notify user that call was rejected
    this.io.to(call.userSocketId).emit('call_rejected', {
      callId,
      reason: reason || 'Expert declined the call'
    });

    // Notify all clients that expert is no longer busy
    this.io.emit('expert_busy_changed', {
      expertId: call.expertId,
      isBusy: false
    });

    callback({ success: true });
    logger.callEvent('call_rejected', { callId, reason });
  }

  // Handle call connected (after WebRTC setup)
  // IMPORTANT: This triggers billing start in backend
  handleCallConnected(socket, data, callback) {
    const { callId } = data;

    const call = rooms.getCall(callId);
    if (!call) {
      logger.error('Call not found', { callId });
      callback({ success: false, error: 'Call not found' });
      return;
    }

    // Update socket room status to connected
    rooms.updateCallStatus(callId, 'connected');

    // Notify both parties (confirmation)
    this.io.to(call.userSocketId).emit('call_connected', { callId });
    this.io.to(call.expertSocketId).emit('call_connected', { callId });

    callback({ success: true, startTime: Date.now() });
    logger.callEvent('call_connected', { callId });
  }

  // Handle call end
  // IMPORTANT: Backend calculates billing and updates balances
  async handleCallEnd(socket, data, callback) {
    const { callId } = data;

    const call = rooms.getCall(callId);
    if (!call) {
      logger.warn('Call not found for end', { callId });
      if (callback) callback({ success: false, error: 'Call not found' });
      return;
    }

    const duration = rooms.getCallDuration(callId);

    // Notify both parties BEFORE cleanup
    const endData = { callId, duration };

    if (call.userSocketId && call.userSocketId !== socket.id) {
      this.io.to(call.userSocketId).emit('call_ended', endData);
    }
    if (call.expertSocketId && call.expertSocketId !== socket.id) {
      this.io.to(call.expertSocketId).emit('call_ended', endData);
    }

    // Remove call from socket rooms
    rooms.endCall(callId);

    // Notify all clients that expert is no longer busy
    this.io.emit('expert_busy_changed', {
      expertId: call.expertId,
      isBusy: false
    });


    // Update expert online status from DB and notify clients
    try {
      const statusRes = await axios.get(`${BACKEND_URL}/api/experts/status/${call.expertId}`);
      const isOnline = !!statusRes.data?.isOnline;

      if (isOnline) {
        rooms.onlineExperts.add(call.expertId);
      } else {
        rooms.onlineExperts.delete(call.expertId);
      }

      this.io.emit('expert_status_changed', { expertId: call.expertId, isOnline });
      logger.info(`Expert status updated after call end: ${call.expertId}, online=${isOnline}`);
    } catch (error) {
      logger.error(`Failed to update expert status after call end for ${call.expertId}:`, error.message);
    }

    // Clear timeout if exists
    if (this.callTimeouts.has(callId)) {
      clearTimeout(this.callTimeouts.get(callId));
      this.callTimeouts.delete(callId);
    }

    if (callback) callback({ success: true, duration });
    logger.callEvent('call_ended', { callId, duration });
  }


  // Handle WebRTC signaling - offer
  handleWebRTCOffer(socket, data) {
    const { callId, offer } = data;

    const call = rooms.getCall(callId);
    if (!call) {
      logger.error('Call not found for WebRTC offer', { callId });
      return;
    }

    // Forward offer to expert
    this.io.to(call.expertSocketId).emit('webrtc_offer', {
      callId,
      offer
    });

    logger.debug('WebRTC offer forwarded', { callId });
  }

  // Handle WebRTC signaling - answer
  handleWebRTCAnswer(socket, data) {
    const { callId, answer } = data;

    const call = rooms.getCall(callId);
    if (!call) {
      logger.error('Call not found for WebRTC answer', { callId });
      return;
    }

    // Forward answer to user
    this.io.to(call.userSocketId).emit('webrtc_answer', {
      callId,
      answer
    });

    logger.debug('WebRTC answer forwarded', { callId });
  }

  // Handle WebRTC signaling - ICE candidate
  handleWebRTCIce(socket, data) {
    const { callId, candidate } = data;

    const call = rooms.getCall(callId);
    if (!call) {
      logger.error('Call not found for ICE candidate', { callId });
      return;
    }

    // Forward ICE candidate to the other party
    const targetSocketId = socket.id === call.userSocketId ? call.expertSocketId : call.userSocketId;

    this.io.to(targetSocketId).emit('webrtc_ice', {
      callId,
      candidate
    });

    logger.debug('ICE candidate forwarded', { callId });
  }

  // Handle expert status change
  handleExpertStatusChange(socket, data) {
    const { expertId, isOnline } = data;

    logger.info('🔄 Expert status change', { expertId, isOnline });

    if (isOnline) {
      // Expert coming online - mark online in socket memory and DB
      rooms.expertSockets.set(expertId, socket.id);
      rooms.onlineExperts.add(expertId);

      axios.put(`${BACKEND_URL}/api/experts/set-online-internal/${expertId}`, { isOnline: true })
        .catch(err => logger.error('Failed to set expert online in DB:', err.message));

      logger.info(`✅ Expert set online: ${expertId}`);
    } else {
      // Expert explicitly going offline - mark offline in socket memory and DB
      rooms.onlineExperts.delete(expertId);

      axios.put(`${BACKEND_URL}/api/experts/set-online-internal/${expertId}`, { isOnline: false })
        .catch(err => logger.error('Failed to set expert offline in DB:', err.message));

      logger.info(`❌ Expert set offline: ${expertId}`);
    }

    // Notify all connected clients about status change
    this.io.emit('expert_status_changed', {
      expertId: expertId,
      isOnline: isOnline
    });
  }

  // --- CHAT EVENTS ---

  // Handle send message
  handleSendMessage(socket, data, callback) {
    const { receiverId, content, type = 'text', tempId, chatId } = data;
    const userData = rooms.socketToUser.get(socket.id);

    if (!userData || !receiverId || !content) {
      if (callback) callback({ success: false, error: 'Invalid data' });
      return;
    }

    const { userId, userType } = userData;

    // Find receiver socket
    const receiverSocketId = userType === 'expert'
      ? rooms.userSockets.get(receiverId) // If sender is expert, receiver is user
      : rooms.getExpertSocket(receiverId); // If sender is user, receiver is expert

    const messageData = {
      senderId: userId,
      receiverId,
      content,
      type,
      timestamp: new Date().toISOString(),
      tempId, // Pass back for UI optimistic update confirmation
      ...(chatId ? { chatId } : {})
    };

    // Forward to receiver if online
    if (receiverSocketId) {
      this.io.to(receiverSocketId).emit('receive_message', messageData);
      if (callback) callback({ success: true, status: 'sent' });
    } else {
      // Receiver offline, message stored in DB via API call in frontend usually, 
      // or we could trigger a push notification here
      if (callback) callback({ success: true, status: 'queued' });
    }
  }

  // Handle typing status
  handleTyping(socket, data) {
    const { receiverId, isTyping } = data;
    const userData = rooms.socketToUser.get(socket.id);

    if (!userData) return;

    const { userId, userType } = userData;
    const receiverSocketId = userType === 'expert'
      ? rooms.userSockets.get(receiverId)
      : rooms.getExpertSocket(receiverId);

    if (receiverSocketId) {
      this.io.to(receiverSocketId).emit('typing_status', {
        senderId: userId,
        isTyping
      });
    }
  }

  // Handle message read
  handleMessageRead(socket, data) {
    const { senderId, messageIds } = data; // senderId is who sent the original messages (so we notify them they are read)
    const userData = rooms.socketToUser.get(socket.id); // Current user (reader)

    if (!userData) return;

    const { userType } = userData;
    const senderSocketId = userType === 'expert'
      ? rooms.userSockets.get(senderId)
      : rooms.getExpertSocket(senderId);

    if (senderSocketId) {
      this.io.to(senderSocketId).emit('messages_read', {
        readerId: userData.userId,
        messageIds
      });
    }
  }

  // Handle disconnect
  // IMPORTANT: Notify backend about disconnections during active calls
  // FAIL-SAFE: Instantly stop billing and clear expert status
  async handleDisconnect(socket) {
    const userData = rooms.removeSocket(socket.id);

    if (userData && userData.userType === 'expert') {
      // Expert disconnected: do NOT change DB isOnline (toggle is source of truth).
      // Also do NOT broadcast isOnline=false here, as refresh would incorrectly flip UI.
      logger.info(`Expert disconnected (DB status unchanged): ${userData.userId}`);
    }

    // Clean up any active calls this socket was part of
    // CRITICAL: Process all active calls immediately for instant sync
    const disconnectPromises = [];

    for (const [callId, call] of rooms.activeCalls) {
      if (call.userSocketId === socket.id || call.expertSocketId === socket.id) {
        logger.warn(`🚨 DISCONNECT DETECTED during active call: ${callId}`);

        const isUserDisconnect = call.userSocketId === socket.id;
        const isExpertDisconnect = call.expertSocketId === socket.id;

        // INSTANT NOTIFICATION: Notify the other party IMMEDIATELY (within milliseconds)
        const otherSocketId = isUserDisconnect ? call.expertSocketId : call.userSocketId;
        if (otherSocketId) {
          this.io.to(otherSocketId).emit('call_ended', {
            callId,
            reason: 'Other party disconnected',
            duration: rooms.getCallDuration(callId),
            disconnectType: isUserDisconnect ? 'user' : 'expert'
          });
          logger.info(`⚡ Instant notification sent to other party (socket: ${otherSocketId})`);
        }

        // INSTANT BROADCAST: Notify all clients that expert is no longer busy
        if (call.expertId) {
          this.io.emit('expert_busy_changed', {
            expertId: call.expertId,
            isBusy: false
          });
          logger.info(`⚡ Instant expert busy status cleared: ${call.expertId}`);
        }

        // FAIL-SAFE BILLING STOP: Force end call in backend (stops billing immediately)
        const backendPromise = (async () => {
          try {
            logger.info(`💰 STOPPING BILLING - Force ending call in backend: ${callId}`);
            const response = await axios.post(
              `${BACKEND_URL}/api/calls/internal/end-call/${callId}`,
              { reason: 'socket_disconnect' },
              { timeout: 5000 } // 5 second timeout for fail-safe
            );
            logger.info(`✅ Backend billing stopped successfully for call ${callId}`);
            return { success: true, callId };
          } catch (err) {
            logger.error(`❌ CRITICAL: Failed to stop billing for call ${callId}:`, err.message);
            // Even if backend fails, we still clear local state to prevent stuck calls
            return { success: false, callId, error: err.message };
          }
        })();

        disconnectPromises.push(backendPromise);

        // INSTANT LOCAL CLEANUP: Remove call from socket rooms immediately
        rooms.endCall(callId);

        // Clear any pending timeouts
        if (this.callTimeouts.has(callId)) {
          clearTimeout(this.callTimeouts.get(callId));
          this.callTimeouts.delete(callId);
          logger.info(`⏱️ Cleared call timeout for ${callId}`);
        }

        logger.info(`🧹 Local call cleanup completed for ${callId}`);
      }
    }

    // Wait for all backend calls to complete (with timeout protection)
    if (disconnectPromises.length > 0) {
      const results = await Promise.allSettled(disconnectPromises);
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          if (result.value.success) {
            logger.info(`✅ Disconnect cleanup ${index + 1}/${results.length} successful`);
          } else {
            logger.warn(`⚠️ Disconnect cleanup ${index + 1}/${results.length} failed but local state cleared`);
          }
        } else {
          logger.error(`❌ Disconnect cleanup ${index + 1}/${results.length} rejected:`, result.reason);
        }
      });
    }

    logger.connection(socket.id, userData?.userId || 'unknown', 'disconnected');
  }

  // Handle expert status change from frontend
  handleExpertStatusChange(socket, data) {
    const { expertId, isOnline } = data;

    // Verify the socket belongs to this expert
    const userData = rooms.socketToUser.get(socket.id);
    if (!userData || userData.userId !== expertId || userData.userType !== 'expert') {
      logger.warn('Unauthorized expert status change attempt', { socketId: socket.id, expertId });
      return;
    }

    // Fetch current status from DB and emit to all clients
    axios.get(`${BACKEND_URL}/api/experts/status/${expertId}`)
      .then(response => {
        const dbIsOnline = !!response.data?.isOnline;
        const dbIsBusy = !!response.data?.isBusy;

        // Emit status changes
        this.io.emit('expert_status_changed', { expertId, isOnline: dbIsOnline });
        this.io.emit('expert_busy_changed', { expertId, isBusy: dbIsBusy });

        logger.info(`Expert status synced via socket: ${expertId}, online=${dbIsOnline}, busy=${dbIsBusy}`);
      })
      .catch(error => {
        logger.error(`Failed to sync expert status for ${expertId}:`, error.message);
      });
  }
}

module.exports = EventHandler;
