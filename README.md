# VRPlaced STT WebSocket Server

A dedicated WebSocket server for real-time speech-to-text transcription using Deepgram SDK.

## Features

- **Real-time WebSocket connections** for audio streaming
- **Deepgram integration** for speech-to-text transcription
- **CORS support** for cross-origin requests
- **Session management** for multiple concurrent users
- **Health check endpoint** for monitoring
- **Graceful shutdown** with cleanup

## Quick Start

### Development

1. Install dependencies:
```bash
npm install
```

2. Copy environment variables:
```bash
cp .env.example .env
```

3. Add your Deepgram API key to `.env`:
```
DEEPGRAM_API_KEY=your_deepgram_api_key_here
```

4. Start the server:
```bash
npm run dev
```

The server will start on `http://localhost:8080`

### Production Deployment (Railway)

1. Push this repository to GitHub
2. Connect to Railway
3. Set environment variables in Railway dashboard:
   - `DEEPGRAM_API_KEY`
   - `PORT` (automatically set by Railway)
4. Deploy!

## API Endpoints

### WebSocket Connection

Connect to the WebSocket server:
```
ws://localhost:8080 (development)
wss://your-app.railway.app (production)
```

### Health Check

```
GET /health
```

Returns server status and active connections count.

## WebSocket Protocol

### Client → Server Messages

#### Start Session
```json
{
  "type": "start_session",
  "sessionId": "optional_session_id"
}
```

#### Send Audio Data
```json
{
  "type": "audio_data",
  "audio": "base64_encoded_audio_data",
  "sessionId": "session_id"
}
```

#### End Session
```json
{
  "type": "end_session",
  "sessionId": "session_id"
}
```

### Server → Client Messages

#### Connection Established
```json
{
  "type": "connected",
  "message": "WebSocket connection established"
}
```

#### Session Started
```json
{
  "type": "session_started",
  "sessionId": "generated_session_id"
}
```

#### Deepgram Connected
```json
{
  "type": "deepgram_connected",
  "sessionId": "session_id"
}
```

#### Transcription Result
```json
{
  "type": "transcript",
  "transcript": "transcribed_text",
  "is_final": true,
  "speech_final": true,
  "confidence": 0.95,
  "sessionId": "session_id"
}
```

#### Error
```json
{
  "type": "error",
  "error": "error_message",
  "sessionId": "session_id"
}
```

## Environment Variables

- `DEEPGRAM_API_KEY` - Your Deepgram API key
- `PORT` - Server port (default: 8080)
- `NODE_ENV` - Environment (development/production)

## CORS Configuration

The server allows connections from:
- `https://vrplaced-profiling-git-deepgramstt-mythya-verse.vercel.app`
- `http://localhost:3000`
- `http://127.0.0.1:3000`

Update the `allowedOrigins` array in `server.js` to add more domains.

## Architecture

This WebSocket server is designed to work with the main VRPlaced Next.js application:

1. **Main App** (Vercel) - Serves the UI and handles static requests
2. **WebSocket Server** (Railway) - Handles real-time audio streaming and transcription
3. **Deepgram** - Processes speech-to-text conversion

## Monitoring

The server includes comprehensive logging for:
- Connection events
- Session management
- Deepgram interactions
- Error handling

## Graceful Shutdown

The server handles `SIGINT` signals gracefully:
- Closes all active Deepgram connections
- Cleans up sessions
- Shuts down WebSocket server
- Exits cleanly

## Dependencies

- `@deepgram/sdk` - Deepgram SDK for speech-to-text
- `ws` - WebSocket library for Node.js

## License

MIT