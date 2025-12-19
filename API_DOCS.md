# VRPlaced STT WebSocket API Documentation

Simple, practical guide for integrating real-time Speech-to-Text via WebSocket.

## Connection URLs

### Production
```
wss://vrplaced-stt-websocket-production.up.railway.app
```

### Local Development
```
ws://localhost:8080
```

---

## Quick Start

```javascript
// Connect to the WebSocket
const ws = new WebSocket('wss://vrplaced-stt-websocket-production.up.railway.app');

ws.onopen = () => {
  // Start a session
  ws.send(JSON.stringify({
    type: 'start_session',
    sessionId: 'my-session-123',  // Optional, will auto-generate if not provided
    language: 'en',                // Optional: 'en' or 'ja'
    keyterms: ['VRPlaced', 'Node.js']  // Optional: contextual keywords
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  if (data.type === 'transcript') {
    console.log('Transcript:', data.transcript);
    console.log('Is Final:', data.is_final);
    console.log('Confidence:', data.confidence);
  }
};

// Send audio as base64 or binary
function sendAudio(audioBuffer) {
  // Option 1: Send as binary (recommended - lower overhead)
  ws.send(audioBuffer);

  // Option 2: Send as JSON with base64
  // ws.send(JSON.stringify({
  //   type: 'audio_data',
  //   audio: audioBuffer.toString('base64')
  // }));
}
```

---

## Message Types

### 1. Connection Established

**Sent by server when WebSocket connects**

```json
{
  "type": "connected",
  "message": "WebSocket connection established"
}
```

---

### 2. Start Session

**Client → Server**: Initialize a new transcription session

```json
{
  "type": "start_session",
  "sessionId": "optional-session-id",
  "language": "en",
  "keyterms": ["keyword1", "keyword2"]
}
```

**Parameters:**
- `sessionId` (optional): Your session identifier. Auto-generated if not provided
- `language` (optional): `'en'` (English) or `'ja'` (Japanese). Default: `'en'`
- `keyterms` (optional): Array of keywords for better recognition (max 40)

**Server → Client**: Session started confirmation

```json
{
  "type": "session_started",
  "sessionId": "ws_1234567890_abc123def456",
  "provider": "deepgram"
}
```

---

### 3. STT Provider Connected

**Server → Client**: STT service is ready

```json
{
  "type": "deepgram_connected",
  "sessionId": "ws_1234567890_abc123def456",
  "provider": "deepgram",
  "language": "en"
}
```

**Note**: Message type is `deepgram_connected` for backward compatibility, but `provider` field indicates actual provider (can be "deepgram" or "sarvam").

---

### 4. Send Audio Data

**Client → Server**: Two options for sending audio

#### Option A: Binary (Recommended)
```javascript
// Send audio buffer directly as binary
ws.send(audioBuffer);  // audioBuffer is ArrayBuffer, Uint8Array, or Buffer
```

#### Option B: JSON with Base64
```json
{
  "type": "audio_data",
  "audio": "base64-encoded-audio-data-here"
}
```

**Audio Requirements:**
- Format: Linear16 PCM (raw audio) or WAV
- Sample Rate: 16000 Hz recommended
- Channels: 1 (mono)
- Bit Depth: 16-bit
- Max chunk size: 64KB per message

---

### 5. Receive Transcripts

**Server → Client**: Real-time transcription results

```json
{
  "type": "transcript",
  "transcript": "hello world",
  "is_final": true,
  "speech_final": true,
  "confidence": 0.95,
  "confidence_accept": true,
  "min_confidence": 0.65,
  "sessionId": "ws_1234567890_abc123def456",
  "words": [
    {
      "word": "hello",
      "start": 0.0,
      "end": 0.5,
      "confidence": 0.98
    },
    {
      "word": "world",
      "start": 0.5,
      "end": 1.0,
      "confidence": 0.92
    }
  ]
}
```

**Fields:**
- `transcript`: The transcribed text
- `is_final`: `true` if this is the final version, `false` for interim results
- `speech_final`: `true` when the user has stopped speaking
- `confidence`: Confidence score (0.0 to 1.0)
- `confidence_accept`: Whether confidence meets minimum threshold
- `words`: Array of word-level timing and confidence data

---

### 6. Finalize Stream

**Client → Server**: Flush remaining audio and get final transcripts

```json
{
  "type": "finalize"
}
```

**Server → Client**: Finalize acknowledged

```json
{
  "type": "finalize_sent",
  "sessionId": "ws_1234567890_abc123def456",
  "message": "Waiting for final transcripts"
}
```

**Server → Client**: Finalization complete

```json
{
  "type": "finalization_complete",
  "sessionId": "ws_1234567890_abc123def456",
  "message": "All final transcripts have been sent",
  "timestamp": 1234567890
}
```

---

### 7. Close Stream

**Client → Server**: End current stream but keep session alive

```json
{
  "type": "close_stream"
}
```

**Server → Client**: Stream closed

```json
{
  "type": "deepgram_stream_closed",
  "sessionId": "ws_1234567890_abc123def456",
  "message": "Deepgram stream finalized, ready for next session"
}
```

---

### 8. End Session

**Client → Server**: Completely end the session

```json
{
  "type": "end_session"
}
```

---

### 9. Keep Alive (Heartbeat)

**Client → Server**: Ping to keep connection alive

```json
{
  "type": "ping"
}
```

**Server → Client**: Pong response

```json
{
  "type": "pong",
  "sessionId": "ws_1234567890_abc123def456",
  "timestamp": 1234567890
}
```

**Note**: The server also sends WebSocket-level ping/pong frames every 15 seconds. Your WebSocket client should handle these automatically.

---

### 10. Error Messages

**Server → Client**: Error occurred

```json
{
  "type": "error",
  "error": "Error description",
  "code": "ERROR_CODE",
  "sessionId": "ws_1234567890_abc123def456"
}
```

**Common Error Codes:**
- `INVALID_MESSAGE_TYPE`: Missing or invalid message type
- `INVALID_SESSION_ID`: Session ID format is invalid
- `DEEPGRAM_NOT_READY`: STT service not connected yet
- `BUFFER_TOO_LARGE`: Audio chunk exceeds 64KB limit
- `INVALID_AUDIO_FORMAT`: Audio data format is invalid
- `DEEPGRAM_ERROR`: General STT service error
- `QUOTA_EXCEEDED`: API quota reached
- `AUTH_ERROR`: Authentication failed
- `TIMEOUT`: Connection timeout

---

## HTTP Fallback API

When WebSocket is unavailable, use the HTTP endpoint for pre-recorded audio.

### Endpoint

```
POST https://vrplaced-stt-websocket-production.up.railway.app:8081/api/transcribe
```

**Local:**
```
POST http://localhost:8081/api/transcribe
```

### Request

**Content-Type:** `multipart/form-data`

**Form Fields:**
- `audio` (file, required): Audio file to transcribe
- `language` (string, optional): Language code ('en' or 'ja')
- `model` (string, optional): Model name (default: 'nova-3')
- `keywords` (JSON string, optional): Array of keywords
- `smart_format` (boolean, optional): Enable smart formatting
- `punctuate` (boolean, optional): Add punctuation
- `numerals` (boolean, optional): Convert numbers to digits

### Response

```json
{
  "transcript": "hello world this is a test",
  "confidence": 0.95,
  "words": [
    {
      "word": "hello",
      "start": 0.0,
      "end": 0.5,
      "confidence": 0.98
    }
  ]
}
```

### Example with cURL

```bash
curl -X POST https://vrplaced-stt-websocket-production.up.railway.app:8081/api/transcribe \
  -F "audio=@audio.wav" \
  -F "language=en" \
  -F "keywords=[\"VRPlaced\",\"Node.js\"]"
```

### Example with JavaScript (fetch)

```javascript
const formData = new FormData();
formData.append('audio', audioFile);
formData.append('language', 'en');
formData.append('keywords', JSON.stringify(['VRPlaced', 'Node.js']));

const response = await fetch('https://vrplaced-stt-websocket-production.up.railway.app:8081/api/transcribe', {
  method: 'POST',
  body: formData
});

const result = await response.json();
console.log(result.transcript);
```

---

## Advanced Features

### Multiple STT Providers

The service supports multiple STT providers (Deepgram and Sarvam AI). The provider is automatically selected based on:

1. URL parameters: `?sttProvider=sarvam` or `?sttProvider=deepgram`
2. Embed mode: `?embed=true` (uses Sarvam for Indian language optimization)
3. Language: Indian languages (hi, ta, te) automatically route to Sarvam

**Example:**
```javascript
// Force Sarvam provider
const ws = new WebSocket('wss://vrplaced-stt-websocket-production.up.railway.app?sttProvider=sarvam');
```

### Contextual Keywords

Improve recognition accuracy by providing domain-specific keywords:

```json
{
  "type": "start_session",
  "keyterms": [
    "VRPlaced",
    "JavaScript",
    "Node.js",
    "Express.js",
    "MongoDB"
  ]
}
```

**Limits:**
- Maximum 40 keywords per session
- Keywords are case-sensitive
- Works best with proper nouns and technical terms

---

## Health Check

Check server status:

```
GET https://vrplaced-stt-websocket-production.up.railway.app:8081/health
```

**Response:**
```json
{
  "status": "healthy",
  "activeConnections": 5,
  "maxConnections": 100,
  "deepgramSessions": 3,
  "connectionPool": {
    "active": 3,
    "idle": 2
  },
  "uptime": 86400,
  "memoryUsage": {
    "rss": 150000000,
    "heapTotal": 100000000,
    "heapUsed": 75000000,
    "external": 5000000
  },
  "timestamp": "2025-10-09T12:00:00.000Z"
}
```

---

## Complete Example: Browser Client

```html
<!DOCTYPE html>
<html>
<head>
  <title>STT Test</title>
</head>
<body>
  <button id="start">Start Recording</button>
  <button id="stop">Stop Recording</button>
  <div id="transcript"></div>

  <script>
    let ws;
    let mediaRecorder;
    let sessionId = 'test-' + Date.now();

    document.getElementById('start').onclick = async () => {
      // Connect to WebSocket
      ws = new WebSocket('wss://vrplaced-stt-websocket-production.up.railway.app');

      ws.onopen = () => {
        console.log('Connected');

        // Start session
        ws.send(JSON.stringify({
          type: 'start_session',
          sessionId: sessionId,
          language: 'en'
        }));
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'transcript' && data.is_final) {
          document.getElementById('transcript').innerHTML +=
            '<p>' + data.transcript + ' (confidence: ' + data.confidence + ')</p>';
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      // Start recording audio
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true
        }
      });

      mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm'
      });

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          // Convert to ArrayBuffer and send
          event.data.arrayBuffer().then(buffer => {
            ws.send(buffer);
          });
        }
      };

      mediaRecorder.start(100); // Send chunks every 100ms
    };

    document.getElementById('stop').onclick = () => {
      if (mediaRecorder) {
        mediaRecorder.stop();
      }

      if (ws) {
        // Finalize to get remaining transcripts
        ws.send(JSON.stringify({ type: 'finalize' }));

        // Close after a delay
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'end_session' }));
          ws.close();
        }, 2000);
      }
    };
  </script>
</body>
</html>
```

---

## Complete Example: Node.js Client

```javascript
const WebSocket = require('ws');
const fs = require('fs');

// Connect to WebSocket
const ws = new WebSocket('wss://vrplaced-stt-websocket-production.up.railway.app');

ws.on('open', () => {
  console.log('Connected to STT service');

  // Start session
  ws.send(JSON.stringify({
    type: 'start_session',
    sessionId: 'node-test-' + Date.now(),
    language: 'en',
    keyterms: ['Node.js', 'JavaScript']
  }));
});

ws.on('message', (data) => {
  const message = JSON.parse(data.toString());

  switch (message.type) {
    case 'connected':
      console.log('WebSocket connected');
      break;

    case 'session_started':
      console.log('Session started:', message.sessionId);
      // Start sending audio after session is ready
      sendAudioFile();
      break;

    case 'deepgram_connected':
      console.log('STT provider ready:', message.provider);
      break;

    case 'transcript':
      if (message.is_final) {
        console.log('Final transcript:', message.transcript);
        console.log('Confidence:', message.confidence);
      } else {
        console.log('Interim:', message.transcript);
      }
      break;

    case 'finalization_complete':
      console.log('All transcripts received');
      ws.send(JSON.stringify({ type: 'end_session' }));
      ws.close();
      break;

    case 'error':
      console.error('Error:', message.error, '(Code:', message.code + ')');
      break;
  }
});

ws.on('error', (error) => {
  console.error('WebSocket error:', error);
});

ws.on('close', () => {
  console.log('Connection closed');
});

function sendAudioFile() {
  // Read audio file (must be Linear16 PCM or WAV, 16kHz, mono)
  const audioBuffer = fs.readFileSync('./audio.wav');

  // Split into chunks and send
  const chunkSize = 8192; // 8KB chunks
  for (let i = 0; i < audioBuffer.length; i += chunkSize) {
    const chunk = audioBuffer.slice(i, i + chunkSize);

    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      }
    }, (i / chunkSize) * 100); // Simulate real-time streaming (100ms intervals)
  }

  // Finalize after all audio is sent
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'finalize' }));
  }, (audioBuffer.length / chunkSize + 1) * 100);
}
```

---

## Rate Limits & Quotas

- **Max Connections:** 100 concurrent WebSocket connections
- **Max Message Size:** 1 MB per message
- **Max Audio Chunk:** 64 KB per chunk
- **Rate Limit:** 1000 requests per minute per IP
- **Connection Timeout:** 1 hour max per session
- **Heartbeat Interval:** 15 seconds (server sends ping)

---

## Troubleshooting

### Connection Refused
- Check if the URL is correct (wss:// for production, ws:// for local)
- Verify your origin is allowed (CORS)
- Check server status via `/health` endpoint

### No Transcripts Received
- Ensure session is started before sending audio
- Wait for `deepgram_connected` message before streaming
- Verify audio format (Linear16 PCM or WAV, 16kHz, mono)
- Check audio chunk size (max 64KB)

### Low Confidence Scores
- Improve audio quality (reduce background noise)
- Use appropriate language setting
- Provide contextual keywords for domain-specific terms

### Transcripts Cut Off
- Send `finalize` or `close_stream` message before ending
- Wait for `finalization_complete` message
- Don't close WebSocket immediately after last audio chunk

---

## Best Practices

1. **Always wait for connection confirmation** before sending audio
2. **Send audio in small chunks** (8-16KB) for optimal real-time performance
3. **Handle both interim and final transcripts** for responsive UX
4. **Implement heartbeat/ping** to detect connection issues
5. **Use keywords** for better accuracy on technical/domain-specific terms
6. **Finalize streams** properly to get complete transcripts
7. **Handle errors gracefully** and implement reconnection logic
8. **Monitor confidence scores** to validate transcript quality

---

## Support

For issues or questions:
- Check the `/health` endpoint for service status
- Review error codes in error messages
- Test with the provided example code first
- Verify audio format meets requirements

---

**Last Updated:** October 2025
**API Version:** 1.0.0
