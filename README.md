# ConsultOnCall Socket Server

Real-time Socket.IO server for ConsultOnCall calling functionality.

## Features

- Real-time socket connections for users and experts
- Call management (request, accept, reject, end)
- WebRTC signaling (offer, answer, ICE candidates)
- Expert online/offline status tracking
- Call timeout handling
- In-memory state management

## Deployment on Render

### 1. Connect GitHub Repository

1. Go to [Render Dashboard](https://dashboard.render.com/)
2. Click **New** → **Web Service**
3. Connect your GitHub repository: `consultoncall-socket-server`

### 2. Configure Service

```
Name: consultoncall-socket-server
Environment: Node
Region: Choose nearest to your users
Branch: main (or master)
Build Command: npm install
Start Command: npm start
```

### 3. Environment Variables

Add these environment variables in Render dashboard:

```
PORT=10000
CLIENT_URL=https://abbaslogic.com
NODE_ENV=production
```

### 4. Deploy

Click **Create Web Service** and wait for deployment to complete.

Your socket server will be available at:
```
https://consultoncall-socket-server.onrender.com
```

### 5. Update Frontend

Update Vercel environment variable:
```
REACT_APP_SOCKET_URL=https://consultoncall-socket-server.onrender.com
```

## Local Development

```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env

# Start development server
npm run dev
```

## Socket Events

### Client → Server

- `register` - Register user/expert connection
- `call_request` - User initiates call to expert
- `accept_call` - Expert accepts incoming call
- `reject_call` - Expert rejects incoming call
- `call_connected` - Call WebRTC connection established
- `end_call` - Either party ends the call
- `webrtc_offer` - WebRTC offer
- `webrtc_answer` - WebRTC answer
- `webrtc_ice` - ICE candidate exchange

### Server → Client

- `registered` - Registration confirmation
- `incoming_call` - Expert receives call notification
- `call_accepted` - User notified call accepted
- `call_rejected` - User notified call rejected
- `call_timeout` - Call timed out (30 seconds)
- `call_connected` - Both parties notified of connection
- `call_ended` - Call ended notification
- `expert_status_changed` - Expert online/offline status
- `webrtc_offer` - Forward WebRTC offer
- `webrtc_answer` - Forward WebRTC answer
- `webrtc_ice` - Forward ICE candidate

## Architecture

```
/src
  /utils
    logger.js       # Logging utility
  rooms.js          # In-memory state management
  events.js         # Event handlers
  socket.js         # Socket.IO configuration
  index.js          # Server entry point
```

## Health Check

```
GET /health
```

Returns server status and statistics.

## Notes

- Free tier on Render may spin down with inactivity
- WebSocket connections require persistent server
- No database required - all state in memory
- Calls auto-timeout after 30 seconds if not accepted
