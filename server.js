// Load environment variables from .env file
require('dotenv').config();

const WebSocket = require('ws');
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');
const multiparty = require('multiparty');
const fs = require('fs').promises;

// Import STT provider services
const SarvamWebSocketService = require('./services/sarvamWebSocketService');
const SarvamHttpService = require('./services/sarvamHttpService');
const STTProviderRouter = require('./services/sttProviderRouter');

// Configuration
const port = process.env.PORT || 8080;
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS) || 100;
const MAX_MESSAGE_SIZE = parseInt(process.env.MAX_MESSAGE_SIZE) || 1024 * 1024; // 1MB default
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL) || 15000; // 15 seconds default
const ENABLE_WILDCARD_CORS = process.env.ENABLE_WILDCARD_CORS === 'true';
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW) || 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 1000; // 1000 requests per minute

// Sarvam AI Configuration
const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const SARVAM_API_URL = process.env.SARVAM_API_URL || 'https://api.sarvam.ai/v1';
const SARVAM_WS_URL = process.env.SARVAM_WS_URL || 'wss://api.sarvam.ai/v1';
const DEFAULT_STT_PROVIDER = process.env.DEFAULT_STT_PROVIDER || 'deepgram';
const ENABLE_SARVAM_STT = process.env.ENABLE_SARVAM_STT === 'true';
// STT tuning and safety defaults (override via env)
const DEFAULT_MODEL = process.env.DG_MODEL || process.env.DEEPGRAM_MODEL || 'nova-3';
const STT_LANGUAGE = process.env.STT_LANGUAGE || process.env.DG_LANGUAGE || 'en';
const ENDPOINTING_MS = parseInt(process.env.ENDPOINTING_MS || '350');
const UTTERANCE_END_MS = parseInt(process.env.UTTERANCE_END_MS || '1500');
const MIN_FINAL_CONFIDENCE = parseFloat(process.env.MIN_FINAL_CONFIDENCE || '0.65');
const MAX_AUDIO_BUFFER_SIZE = parseInt(process.env.MAX_AUDIO_BUFFER_SIZE || String(64 * 1024)); // 64KB per chunk
const MAX_KEYTERMS = parseInt(process.env.MAX_KEYTERMS || '40');
const FAST_FINALIZATION_TIMEOUT_MS = parseInt(process.env.FAST_FINALIZATION_TIMEOUT_MS || '1500'); // When speech_final is recent
const STANDARD_FINALIZATION_TIMEOUT_MS = parseInt(process.env.STANDARD_FINALIZATION_TIMEOUT_MS || '10000'); // When no recent speech_final

// Connection tracking for security
let currentConnections = 0;

// Rate limiting tracking with automatic cleanup
const rateLimitMap = new Map(); // Track requests per IP

// Clean up old rate limit entries every minute
const rateLimitCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [ip, limit] of rateLimitMap.entries()) {
    if (now > limit.resetTime + RATE_LIMIT_WINDOW) {
      rateLimitMap.delete(ip);
    }
  }
}, 60000);

// Connection pool for Deepgram
const connectionPool = {
  active: new Map(),
  idle: [],
  maxIdle: 5,
  maxAge: 300000, // 5 minutes
  // Add connection reuse logic
  acquire: async function(sessionId) {
    // Check if we have an idle connection
    if (this.idle.length > 0) {
      const conn = this.idle.pop();
      if (Date.now() - conn.createdAt < this.maxAge) {
        this.active.set(sessionId, conn);
        // Return the full connection object, not just the Deepgram connection
        return conn;
      }
      // Connection too old, close it
      try {
        conn.connection.finish();
      } catch (e) {
        console.log('Error closing stale connection:', e);
      }
    }
    return null; // Need to create new connection
  },
  release: function(sessionId) {
    const conn = this.active.get(sessionId);
    if (conn) {
      this.active.delete(sessionId);
      if (this.idle.length < this.maxIdle) {
        this.idle.push(conn);
      } else {
        // Pool full, close connection
        try {
          conn.connection.finish();
        } catch (e) {
          console.log('Error closing excess connection:', e);
        }
      }
    }
  }
};

// Add finalization tracking
const finalizationPending = new Map(); // Track sessions waiting for finalization
const finalizationTimeouts = new Map(); // Track timeouts for each session
const lastSpeechFinalTime = new Map(); // Track when last speech_final was received per session

// Parse allowed origins from environment variable or use defaults
const defaultOrigins = [
  'https://vrplaced-profiling-git-deepgramstt-mythya-verse.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : defaultOrigins;

// Helper function for flexible CORS checking
const isOriginAllowed = (origin) => {
  if (!origin) return false;
  
  // Exact match
  if (allowedOrigins.includes(origin)) return true;
  
  // Wildcard subdomain support if enabled
  if (ENABLE_WILDCARD_CORS) {
    // Check for wildcard patterns like *.vrplaced.com
    return allowedOrigins.some(allowed => {
      if (allowed.includes('*')) {
        const pattern = allowed.replace(/\*/g, '.*').replace(/\./g, '\\.');
        const regex = new RegExp(`^${pattern}$`);
        return regex.test(origin);
      }
      return false;
    });
  }
  
  return false;
};

const deepgramApiKey = process.env.DEEPGRAM_API_KEY || process.env.DeepGram_API_Key;
if (!deepgramApiKey) {
  console.error('❌ CRITICAL: Deepgram API key not configured!');
  console.error('Please set either DEEPGRAM_API_KEY or DeepGram_API_Key environment variable');
  process.exit(1);
}

// Initialize STT Provider Router
const sttRouter = new STTProviderRouter({
  defaultProvider: DEFAULT_STT_PROVIDER,
  debug: process.env.NODE_ENV === 'development'
});

// Initialize Sarvam services if enabled
let sarvamWebSocketService = null;
let sarvamHttpService = null;

if (ENABLE_SARVAM_STT && SARVAM_API_KEY) {
  console.log('✅ Sarvam AI STT enabled');
  // API key check done silently
  sarvamWebSocketService = new SarvamWebSocketService(SARVAM_API_KEY, {
    baseUrl: SARVAM_WS_URL,
    debug: false  // Reduced logging
  });
  sarvamHttpService = new SarvamHttpService(SARVAM_API_KEY, {
    baseUrl: SARVAM_API_URL,
    debug: false  // Consistent with WebSocket service
  });
  
  // Register Sarvam as a provider
  sttRouter.registerProvider('sarvam', {
    websocket: sarvamWebSocketService,
    http: sarvamHttpService
  });
} else if (ENABLE_SARVAM_STT) {
  console.warn('⚠️ Sarvam AI STT is enabled but SARVAM_API_KEY is not configured');
}

// Register Deepgram as a provider (always available)
sttRouter.registerProvider('deepgram', {
  websocket: 'native', // Use existing Deepgram implementation
  http: 'native'
});

// Store active STT connections (both Deepgram and Sarvam)
const deepgramConnections = new Map();
const sttConnections = new Map(); // Generic map for all STT connections
const connectionProviders = new Map(); // Track which provider each connection uses
const sessionLanguages = new Map(); // Track language per session

// ============================================================================
// FIX #1: Per-Session State Management
// Replaces shared isDeepgramConnected boolean with isolated per-session state
// to prevent race conditions when old session's Close event fires after new
// session starts.
// ============================================================================
const sessionStates = new Map();
let lastSessionEndTime = 0;

// ============================================================================
// SILENT FAILURE DETECTION
// Tracks when audio is being sent vs when ANY response from Deepgram is received.
// If audio sent but NO response from Deepgram for 10+ seconds, warns user.
// This detects network issues where connection appears open but data isn't flowing.
// IMPORTANT: We track ANY Deepgram response (Transcript, Metadata, VAD events)
// to avoid false positives when user is silent (Deepgram still sends empty events).
// ============================================================================
const silentFailureTracking = new Map(); // sessionId -> { lastAudioTime, lastDeepgramResponseTime, warningSent, audioCount }
const SILENT_FAILURE_THRESHOLD_MS = 10000; // 10 seconds

/**
 * Get or create session state for a given session ID.
 * Each session gets its own isolated state to prevent cross-session interference.
 * IMPORTANT: Returns null for stale/cleaned-up states to ensure events are ignored.
 */
function getSessionState(sessionId) {
  if (!sessionId) return null;
  
  // Check if state exists and is NOT stale
  const existing = sessionStates.get(sessionId);
  if (existing) {
    // If marked as stale, return null to force event handlers to ignore
    if (existing.stale) {
      return null;
    }
    return existing;
  }
  
  // Create new state only if doesn't exist
  const newState = {
    isConnected: false,
    connection: null,
    heartbeatInterval: null,
    createdAt: Date.now(),
    stale: false, // Mark as stale when session ends
    // Unique connection ID to detect stale event handlers
    connectionId: `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  };
  sessionStates.set(sessionId, newState);
  return newState;
}

/**
 * Clean up session state completely. Called after end_session.
 * CRITICAL: Immediately marks state as stale so event handlers ignore it.
 */
function cleanupSessionState(sessionId) {
  const state = sessionStates.get(sessionId);
  if (state) {
    // CRITICAL: Mark as stale IMMEDIATELY so event handlers ignore events
    state.stale = true;
    console.log(`🚫 Marked session ${sessionId} as stale (events will be ignored)`);
    
    // Clear heartbeat
    if (state.heartbeatInterval) {
      clearInterval(state.heartbeatInterval);
      state.heartbeatInterval = null;
      console.log(`💔 Cleared per-session heartbeat for: ${sessionId}`);
    }
    // Clean up connection
    if (state.connection) {
      try {
        state.connection.finish();
      } catch (e) {
        console.log(`⚠️ Error finishing connection during cleanup: ${e.message}`);
      }
      state.connection = null;
    }
    state.isConnected = false;
  }
  // Delay actual deletion to let stale events fire and be logged
  setTimeout(() => {
    sessionStates.delete(sessionId);
    console.log(`🧹 Removed session state for: ${sessionId}`);
  }, 500);
}

// Deepgram supported languages - Simplified to only well-tested languages
const DEEPGRAM_SUPPORTED_LANGUAGES = [
  'en', 'ja' // Only English and Japanese for now
];

// Connection health check functions
const connectionHealthChecks = new Map();

const startConnectionHealthCheck = (sessionId, ws, deepgramConnection) => {
  // Clear any existing health check
  stopConnectionHealthCheck(sessionId);
  
  const healthCheck = {
    lastActivity: Date.now(),
    checkInterval: setInterval(() => {
      const now = Date.now();
      const timeSinceActivity = now - healthCheck.lastActivity;

      // If no activity for 5 minutes, check connection status
      // NOTE: Deepgram has NO session timeout - only 10s idle (handled by KeepAlive)
      // This is just a conservative check for very long idle periods
      if (timeSinceActivity > 300000) { // 5 minutes
        console.log(`⚠️ No Deepgram activity for ${Math.round(timeSinceActivity/1000)}s on session: ${sessionId}`);

        // Try to recover the connection
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'connection_health_warning',
            sessionId,
            message: 'Deepgram connection may be stale',
            lastActivity: healthCheck.lastActivity
          }));
        }
      }
    }, 60000) // Check every 60 seconds (was 15s)
  };
  
  connectionHealthChecks.set(sessionId, healthCheck);
};

const stopConnectionHealthCheck = (sessionId) => {
  const healthCheck = connectionHealthChecks.get(sessionId);
  if (healthCheck) {
    clearInterval(healthCheck.checkInterval);
    connectionHealthChecks.delete(sessionId);
  }
};

const updateConnectionActivity = (sessionId) => {
  const healthCheck = connectionHealthChecks.get(sessionId);
  if (healthCheck) {
    healthCheck.lastActivity = Date.now();
  }
};

// Function to send finalization complete signal
const sendFinalizationComplete = (sessionId, ws) => {
  console.log(`🎉 Sending finalization complete for session: ${sessionId}`);
  
  // Clear timeout
  const timeout = finalizationTimeouts.get(sessionId);
  if (timeout) {
    clearTimeout(timeout);
    finalizationTimeouts.delete(sessionId);
  }
  
  // Remove from pending
  finalizationPending.delete(sessionId);
  
  // Send completion signal to client
  ws.send(JSON.stringify({
    type: 'finalization_complete',
    sessionId,
    message: 'All final transcripts have been sent',
    timestamp: Date.now()
  }));
};

// Default keywords focused on Node.js interview skills + company/project names
const defaultKeywords = process.env.DEFAULT_KEYWORDS 
  ? process.env.DEFAULT_KEYWORDS.split(',').map(kw => kw.trim())
  : [
      'VRPlaced',
      'MythyaVerse',
      'HR Connect',
      'Shadev',
      'Shadev Kumar',
      'Sumit',
      'Express.js',
      'ExpressJS',
      'Node.js',
      'NodeJS',
      'JavaScript',
      'NestJS',
      'Fastify',
      'Koa',
      'Socket.io',
      'PM2',
      'Node.js',
      'Prisma',
      'TypeORM',
      'Sequelize',
      'Mongoose',
      'PostgreSQL',
      'MongoDB',
      'Redis',
      'BullMQ',
      'Kafka',
      'RabbitMQ',
      'Docker',
      'OpenAPI',
      'Swagger',
      'Zod',
      'Joi',
      'JWT',
      'bcrypt',
      'Jest',
      'Supertest',
      'Winston',
      'Morgan',
      'EventEmitter',
      'N-API',
      'V8'
    ];

console.log('🚀 Starting VRPlaced STT WebSocket Server...');
console.log(`📡 Port: ${port}`);
// console.log(`🌐 Allowed Origins ${process.env.ALLOWED_ORIGINS ? '(from env)' : '(defaults)'}: ${allowedOrigins.join(', ')}`);
// console.log(`🎯 Keywords ${process.env.DEFAULT_KEYWORDS ? '(from env)' : '(defaults)'}: ${defaultKeywords.join(', ')}`);
// console.log(`🧠 Model: ${DEFAULT_MODEL}, Language: ${STT_LANGUAGE}, Endpointing: ${ENDPOINTING_MS}ms, UtteranceEnd: ${UTTERANCE_END_MS}ms`);

// Create WebSocket server with noServer mode (will be attached to HTTP server later)
const wss = new WebSocket.Server({
  noServer: true,
  maxPayload: MAX_MESSAGE_SIZE,
  perMessageDeflate: {
    zlibDeflateOptions: {
      // Best speed
      level: 1
    },
    threshold: 1024, // Only compress messages larger than 1KB
    concurrencyLimit: 10
  }
});

// Verify client for WebSocket upgrade requests
const verifyWebSocketClient = (info, cb) => {
  const clientIP = info.req.socket.remoteAddress;
  const origin = info.origin;

  // Rate limiting check
  const now = Date.now();
  const clientRateLimit = rateLimitMap.get(clientIP) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };

  if (now > clientRateLimit.resetTime) {
    clientRateLimit.count = 0;
    clientRateLimit.resetTime = now + RATE_LIMIT_WINDOW;
  }

  if (clientRateLimit.count >= RATE_LIMIT_MAX_REQUESTS) {
    console.log(`❌ Rate limit exceeded for IP: ${clientIP}`);
    cb(false, 429, 'Too Many Requests');
    return;
  }

  clientRateLimit.count++;
  rateLimitMap.set(clientIP, clientRateLimit);

  // Check connection limit
  if (currentConnections >= MAX_CONNECTIONS) {
    console.log(`❌ Rejected connection - max connections reached: ${currentConnections}/${MAX_CONNECTIONS}`);
    cb(false, 503, 'Service Unavailable - Max Connections Reached');
    return;
  }

  // Check origin with flexible matching
  const isAllowed = isOriginAllowed(origin);

  if (!isAllowed) {
    console.log(`❌ Rejected connection from unauthorized origin: ${origin}`);
    console.log(`ℹ️  Allowed origins: ${allowedOrigins.join(', ')}`);
    cb(false, 403, 'Forbidden - Invalid Origin');
    return;
  }

  console.log(`✅ Accepted connection from: ${origin} (${currentConnections + 1}/${MAX_CONNECTIONS})`);
  console.log(`📊 Client IP: ${clientIP}, Model: ${DEFAULT_MODEL}`);
  cb(true);
};

wss.on('connection', (ws, req) => {
  const clientOrigin = req.headers.origin;
  const clientIP = req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const connectionTime = Date.now();
  currentConnections++;
  
  console.log(`🔌 New WebSocket connection`);
  console.log(`   Origin: ${clientOrigin}`);
  console.log(`   IP: ${clientIP}`);
  console.log(`   User-Agent: ${userAgent}`);
  console.log(`   Active Connections: ${currentConnections}/${MAX_CONNECTIONS}`);
  
  // Parse connection context for STT provider routing
  const connectionContext = sttRouter.parseConnectionParams(req.url, req.headers);
  let currentSTTProvider = sttRouter.determineProvider(connectionContext);
  console.log(`🎯 STT Provider determined: ${currentSTTProvider} (embed=${connectionContext.embed}, embedType=${connectionContext.embedType})`);
  
  // Set connection timeout (1 hour max)
  const connectionTimeout = setTimeout(() => {
    console.log(`⏰ Connection timeout reached for session: ${sessionId || 'unknown'}`);
    ws.close(1000, 'Connection timeout');
  }, 3600000); // 1 hour
  
  let sessionId = null;
  let sessionIdLocked = false; // Prevent sessionId reassignment after first assignment
  let deepgramConnection = null;
  let sarvamConnection = null;
  let isDeepgramConnected = false;
  let isSarvamConnected = false;
  let heartbeatInterval = null;
  let isAlive = true;
  let audioRetryQueue = []; // Queue for failed audio sends

  // Simplified: directly use provided keywords list
  const parseAndNormalizeKeywords = (rawList) => {
    if (!Array.isArray(rawList)) return undefined;
    const cleaned = [];
    for (const item of rawList) {
      if (typeof item !== 'string') continue;
      const term = item.trim();
      if (!term || term.length < 2) continue;
      cleaned.push(term.includes(':') ? term : `${term}:1.5`);
      if (cleaned.length >= MAX_KEYTERMS) break;
    }
    return cleaned.length > 0 ? cleaned : undefined;
  };

  // Sanitize client-provided keyterms (plain strings, no weights)
  const sanitizeKeyterms = (rawList) => {
    if (!Array.isArray(rawList)) return undefined;
    const unique = new Set();
    for (const item of rawList) {
      if (typeof item !== 'string') continue;
      const term = item.trim();
      if (!term || term.length < 2) continue;
      unique.add(term);
      if (unique.size >= MAX_KEYTERMS) break;
    }
    return unique.size > 0 ? Array.from(unique) : undefined;
  };

  const extractKeyterms = (rawList) => {
    if (!Array.isArray(rawList)) return undefined;
    const terms = [];
    for (const item of rawList) {
      if (typeof item !== 'string') continue;
      const [termRaw] = item.split(':');
      const term = termRaw?.trim();
      if (!term || term.length < 2) continue;
      terms.push(term);
      if (terms.length >= MAX_KEYTERMS) break;
    }
    return terms.length > 0 ? terms : undefined;
  };

  // Helper: forward audio buffer to Deepgram with safety checks and retry logic
  const forwardAudioToDeepgram = (buffer, retryCount = 0) => {
    // ================================================================
    // FIX #5: Validate Connection Using Per-Session State
    // Use getSessionState instead of shared isDeepgramConnected
    // ================================================================
    
    // CRITICAL FIX: Validate sessionId is not null before processing audio
    if (sessionId === null) {
      console.warn(`⚠️ Audio received before sessionId initialized, rejecting`);
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Session not initialized. Please send start_session first.',
        code: 'SESSION_NOT_INITIALIZED'
      }));
      return;
    }

    // Get per-session state for this session
    const state = getSessionState(sessionId);
    const currentConnection = state?.connection || deepgramConnection;
    const currentConnectionState = state?.isConnected || isDeepgramConnected;

    if (!currentConnection || !currentConnectionState) {
      // BUFFER AUDIO instead of rejecting - Deepgram may still be connecting
      if (audioRetryQueue.length < 100) { // Max 100 chunks (~15 seconds of audio)
        audioRetryQueue.push(buffer);
        if (audioRetryQueue.length === 1) {
          console.log(`📦 Buffering audio while Deepgram connects for session: ${sessionId}`);
        }
        if (audioRetryQueue.length % 20 === 0) {
          console.log(`📦 Audio buffer size: ${audioRetryQueue.length} chunks for session: ${sessionId}`);
        }
      } else {
        console.warn(`⚠️ Audio buffer full (100 chunks), dropping audio for session: ${sessionId}`);
      }
      return;
    }

    if (!Buffer.isBuffer(buffer)) {
      return;
    }

    if (buffer.length > MAX_AUDIO_BUFFER_SIZE) {
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Audio buffer too large',
        sessionId,
        code: 'BUFFER_TOO_LARGE'
      }));
      return;
    }
    if (buffer.length === 0) return;

    try {
      currentConnection.send(buffer);
      
      // SILENT FAILURE DETECTION: Track when audio is sent
      let tracking = silentFailureTracking.get(sessionId);
      if (!tracking) {
        tracking = { lastAudioTime: Date.now(), lastDeepgramResponseTime: Date.now(), warningSent: false, audioCount: 0 };
        silentFailureTracking.set(sessionId, tracking);
      }
      tracking.lastAudioTime = Date.now();
      tracking.audioCount = (tracking.audioCount || 0) + 1;
      
      // Check for silent failure every 50 audio chunks
      if (tracking.audioCount % 50 === 0) {
        const timeSinceResponse = Date.now() - tracking.lastDeepgramResponseTime;
        if (timeSinceResponse > SILENT_FAILURE_THRESHOLD_MS && !tracking.warningSent) {
          console.error(`🔇 SILENT FAILURE DETECTED for session ${sessionId}: No Deepgram response for ${Math.round(timeSinceResponse/1000)}s despite ${tracking.audioCount} audio chunks sent`);
          tracking.warningSent = true;
          
          // Notify client about potential issue
          ws.send(JSON.stringify({
            type: 'connection_health_warning',
            sessionId,
            message: 'No response from Deepgram despite audio being sent. Connection may be stale.',
            timeSinceLastResponse: timeSinceResponse,
            audioChunksSent: tracking.audioCount
          }));
        }
      }
      
      // Clear retry queue on successful send
      if (audioRetryQueue.length > 0) {
        console.log(`✅ Connection recovered, processing ${audioRetryQueue.length} queued audio chunks`);
        const queue = [...audioRetryQueue];
        audioRetryQueue = [];
        queue.forEach(queuedBuffer => forwardAudioToDeepgram(queuedBuffer, 0));
      }
    } catch (sendError) {
      if (sendError.message?.includes('WebSocket is not open')) {
        // Update BOTH per-session state AND legacy flag
        if (state) state.isConnected = false;
        isDeepgramConnected = false;

        // RETRY LOGIC: Queue audio for retry (max 3 attempts, max 50 chunks)
        if (retryCount < 3 && audioRetryQueue.length < 50) {
          audioRetryQueue.push(buffer);
          console.log(`🔄 Audio send failed, queued for retry (attempt ${retryCount + 1}/3, queue size: ${audioRetryQueue.length})`);

          // Attempt retry after 1 second
          setTimeout(() => {
            // CRITICAL FIX: Re-check using per-session state
            const retryState = getSessionState(sessionId);
            if (retryState?.connection && retryState?.isConnected) {
              console.log(`🔄 Retrying queued audio (attempt ${retryCount + 1})`);
              forwardAudioToDeepgram(buffer, retryCount + 1);
            } else {
              console.log(`⚠️ Connection not ready during retry, skipping stale retry`);
            }
          }, 1000);
        } else {
          console.error(`❌ Audio lost after ${retryCount} retries or queue full`);
          ws.send(JSON.stringify({
            type: 'error',
            error: 'Deepgram connection closed during transmission',
            sessionId,
            code: 'CONNECTION_CLOSED',
            audioLost: true
          }));
        }
      } else {
        throw sendError;
      }
    }
  };
  
  // Connection health monitoring with configurable interval
  const startHeartbeat = () => {
    heartbeatInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        if (!isAlive) {
          console.log(`💔 Client ${sessionId} failed to respond to ping after ${HEARTBEAT_INTERVAL}ms, terminating connection`);
          ws.terminate();
          return;
        }
        
        isAlive = false;
        ws.ping();
        if (sessionId) {
          console.log(`💓 Sent heartbeat ping to session: ${sessionId}`);
        }
      }
    }, HEARTBEAT_INTERVAL);
  };
  
  // Handle pong responses
  ws.on('pong', () => {
    isAlive = true;
    console.log(`💚 Received heartbeat pong from session: ${sessionId}`);
  });
  
  // Handle ping from client (respond with pong)
  ws.on('ping', () => {
    console.log(`💛 Received ping from session: ${sessionId}, sending pong`);
    ws.pong();
  });

  // Handle incoming WebSocket messages
  ws.on('message', async (message, isBinary) => {
    try {
      // Support binary audio frames directly for lower overhead
      if (isBinary) {
        // Validate binary message size
        if (message.length > MAX_AUDIO_BUFFER_SIZE) {
          ws.send(JSON.stringify({
            type: 'error',
            error: 'Binary audio buffer too large',
            sessionId,
            code: 'BINARY_BUFFER_TOO_LARGE',
            maxSize: MAX_AUDIO_BUFFER_SIZE
          }));
          return;
        }
        
        // Route audio to appropriate provider
        if (currentSTTProvider === 'sarvam' && sarvamConnection) {
          try {
            // Send audio to Sarvam
            sarvamWebSocketService.sendAudio(sessionId, message).catch(error => {
              console.error(`❌ [Sarvam] Failed to send audio for ${sessionId}:`, error);
              // Update connection state and fallback to Deepgram
              isSarvamConnected = false;
              forwardAudioToDeepgram(message);
            });
          } catch (error) {
            console.error(`❌ [Sarvam] Error sending audio:`, error);
            // Fallback to Deepgram
            forwardAudioToDeepgram(message);
          }
        } else {
          // Send to Deepgram (default/fallback)
          forwardAudioToDeepgram(message);
        }
        return;
      }

      const data = JSON.parse(message.toString());
      
      // Validate message type
      if (!data.type || typeof data.type !== 'string') {
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Invalid message: missing or invalid type field',
          code: 'INVALID_MESSAGE_TYPE'
        }));
        return;
      }
      
      switch (data.type) {
        case 'start_session':
          // AUTO-CLEANUP: If session is locked, cleanup old session before starting new one
          // This makes the server resilient to client timing issues (client may send start_session
          // before end_session arrives, especially in persistent WebSocket mode)
          if (sessionIdLocked) {
            console.log(`🔄 Auto-cleanup: Ending existing session ${sessionId} before starting new one`);

            // Cleanup old session (same logic as end_session)
            if (heartbeatInterval) {
              clearInterval(heartbeatInterval);
              heartbeatInterval = null;
            }

            const oldSessionState = getSessionState(sessionId);
            if (oldSessionState?.heartbeatInterval) {
              clearInterval(oldSessionState.heartbeatInterval);
              oldSessionState.heartbeatInterval = null;
            }

            // Close existing Deepgram connection
            if (deepgramConnection) {
              try {
                deepgramConnection.finish();
                deepgramConnections.delete(sessionId);
              } catch (err) {
                console.warn(`⚠️ Auto-cleanup: Error closing old Deepgram connection:`, err.message);
              }
            }

            // Close existing Sarvam connection
            if (sarvamConnection && sarvamWebSocketService) {
              try {
                await sarvamWebSocketService.closeSession(sessionId);
                sarvamConnection = null;
                isSarvamConnected = false;
              } catch (err) {
                console.warn(`⚠️ Auto-cleanup: Error closing old Sarvam connection:`, err.message);
              }
            }

            // Cleanup state
            connectionProviders.delete(sessionId);
            sessionLanguages.delete(sessionId);
            lastSpeechFinalTime.delete(sessionId);
            silentFailureTracking.delete(sessionId);
            stopConnectionHealthCheck(sessionId);
            if (sessionId) {
              cleanupSessionState(sessionId);
            }

            // Reset state for new session
            sessionId = null;
            sessionIdLocked = false;
            isDeepgramConnected = false;
            isSarvamConnected = false;
            deepgramConnection = null;
            audioRetryQueue = [];
            lastSessionEndTime = Date.now();

            console.log(`✅ Auto-cleanup complete, ready for new session`);
          }

          // ================================================================
          // FIX #4: Debounce New Session After End
          // Prevents race condition by ensuring minimum gap between sessions
          // ================================================================
          const timeSinceLastEnd = Date.now() - lastSessionEndTime;
          const minGapMs = 200; // 200ms minimum gap between sessions
          
          if (timeSinceLastEnd < minGapMs && lastSessionEndTime > 0) {
            const waitTime = minGapMs - timeSinceLastEnd;
            console.log(`⏳ Waiting ${waitTime}ms before creating new session (debounce)...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }

          // Update provider selection based on session data
          if (data.embed !== undefined || data.embedType !== undefined) {
            connectionContext.embed = data.embed || connectionContext.embed;
            connectionContext.embedType = data.embedType || connectionContext.embedType;
            currentSTTProvider = sttRouter.determineProvider(connectionContext);
            console.log(`🔄 STT Provider updated based on session: ${currentSTTProvider}`);
          }
          // Validate session ID if provided
          if (data.sessionId) {
            // Basic validation for session ID format
            if (typeof data.sessionId !== 'string' || data.sessionId.length > 100) {
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Invalid session ID format',
                code: 'INVALID_SESSION_ID'
              }));
              return;
            }
            sessionId = data.sessionId;
          } else {
            // Generate secure session ID if not provided
            sessionId = `ws_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
          }

          // Lock sessionId after first assignment
          sessionIdLocked = true;
          
          // Handle language parameter - accept from client or use default
          let sessionLanguage = STT_LANGUAGE; // Default to environment variable
          if (data.language) {
            // Validate language code
            if (DEEPGRAM_SUPPORTED_LANGUAGES.includes(data.language)) {
              sessionLanguage = data.language;
              console.log(`🌐 Session ${sessionId} using language: ${sessionLanguage}`);
            } else {
              console.warn(`⚠️ Unsupported language '${data.language}' requested, using default: ${STT_LANGUAGE}`);
            }
          }
          // Store language for this session
          sessionLanguages.set(sessionId, sessionLanguage);
          
          console.log(`🎯 Starting/Refreshing ${currentSTTProvider} session: ${sessionId} (language: ${sessionLanguage})`);
          
          // Extract keyterms early for use by all providers
          const rawClientKeyterms = Array.isArray(data.keyterms)
            ? data.keyterms
            : (data.context && Array.isArray(data.context.keyterms) ? data.context.keyterms : undefined);
          const incomingKeyterms = sanitizeKeyterms(rawClientKeyterms);
          
          // Fallback to current defaults when client keyterms are not provided
          const fallbackKeyterms = extractKeyterms(defaultKeywords);
          
          // Store provider info for this session
          connectionProviders.set(sessionId, currentSTTProvider);
          
          // Route to appropriate STT provider
          if (currentSTTProvider === 'sarvam' && sarvamWebSocketService) {
            // Using Sarvam AI for this session
            
            try {
              // Clean up existing Sarvam connection if any
              if (sarvamConnection) {
                await sarvamWebSocketService.closeSession(sessionId);
                sarvamConnection = null;
                isSarvamConnected = false;
              }
              
              // Prepare Sarvam-specific options
              const sarvamOptions = {
                language_code: data.language || 'en-IN',
                model: data.sarvamModel || 'saarika:v2.5',
                high_vad_sensitivity: true,
                vad_signals: true,
                keywords: sttRouter.mapKeywords(incomingKeyterms || fallbackKeyterms || [], 'sarvam')
              };
              
              // Create Sarvam session
              sarvamConnection = await sarvamWebSocketService.createSession(sessionId, sarvamOptions);
              isSarvamConnected = true;
              
              // Store connection reference
              sttConnections.set(sessionId, sarvamConnection);
              
              // Set up Sarvam event handlers
              sarvamWebSocketService.setupEventHandlers(
                sessionId,
                // onMessage - forward Sarvam messages to client
                (message) => {
                  ws.send(JSON.stringify(message));
                },
                // onError
                (error) => {
                  console.error(`❌ Sarvam error for session ${sessionId}:`, error);
                  ws.send(JSON.stringify(error));
                },
                // onClose
                (closeEvent) => {
                  isSarvamConnected = false;
                  ws.send(JSON.stringify({
                    type: 'deepgram_closed', // Keep same event name for compatibility
                    sessionId,
                    provider: 'sarvam'
                  }));
                }
              );
              
              // Send connection confirmation (use same event name for compatibility)
              ws.send(JSON.stringify({
                type: 'deepgram_connected',
                sessionId,
                provider: 'sarvam'
              }));
              
              // Start heartbeat monitoring
              startHeartbeat();
              
              // Confirm session started
              ws.send(JSON.stringify({
                type: 'session_started',
                sessionId,
                provider: 'sarvam'
              }));
              
              break; // Exit switch case for Sarvam
            } catch (error) {
              console.error(`❌ Failed to create Sarvam session:`, error);
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Failed to create Sarvam connection',
                code: 'SARVAM_CONNECTION_FAILED',
                fallback: 'deepgram'
              }));
              // Clean up failed connection and fall back to Deepgram
              isSarvamConnected = false;
              sarvamConnection = null;
              currentSTTProvider = 'deepgram';
              connectionProviders.set(sessionId, 'deepgram');
              console.log(`🔄 Falling back to Deepgram for session: ${sessionId}`);
            }
          }
          
          // Continue with Deepgram implementation (default/fallback)
          console.log(`🎯 Using Deepgram for session: ${sessionId}`);
          
          // Try to reuse connection from pool first
          // TEMPORARILY DISABLED for stability - always create fresh connections
          const pooledConn = null; // await connectionPool.acquire(sessionId);
          if (pooledConn && pooledConn.connection) {
            console.log(`♻️ Reusing pooled Deepgram connection for session: ${sessionId}`);
            deepgramConnection = pooledConn.connection;
            isDeepgramConnected = true;

            // Store connection reference
            deepgramConnections.set(sessionId, deepgramConnection);

            // CRITICAL FIX: Add stabilization delay for pooled connections too
            setTimeout(() => {
              if (isDeepgramConnected && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'deepgram_connected',
                  sessionId,
                  pooled: true,
                  provider: 'deepgram'
                }));
              }
            }, 200);
          } else {
            // Close existing connection if any
            if (deepgramConnection) {
              console.log(`🔄 Closing existing Deepgram connection for fresh session`);
              try {
                deepgramConnection.finish();
                deepgramConnections.delete(sessionId);
              } catch (error) {
                console.log(`⚠️ Error closing old connection:`, error);
              }
              isDeepgramConnected = false;
              deepgramConnection = null; // CRITICAL: Clear the reference so new connection can be created
            }
          }
          
          // Create Deepgram client and connection
          const deepgram = createClient(deepgramApiKey);
          const isNova3 = typeof DEFAULT_MODEL === 'string' && DEFAULT_MODEL.toLowerCase().startsWith('nova-3');

          // Note: keyterms already extracted at the beginning of start_session for all providers

          // Retrieve the language for this session from the Map
          const storedLanguage = sessionLanguages.get(sessionId) || STT_LANGUAGE;
          console.log(`🌐 Creating Deepgram connection with language: ${storedLanguage} for session: ${sessionId}`);
          
          // Use nova-2 for Japanese as it's more stable, nova-3 for others
          const modelToUse = storedLanguage === 'ja' ? 'nova-2' : DEFAULT_MODEL;
          console.log(`🎯 Using model ${modelToUse} for language ${storedLanguage}`);
          
          const liveOptions = {
            // Formatting & model
            model: modelToUse,
            language: storedLanguage, // Use session-specific language from Map
            smart_format: true,
            punctuate: true,
            numerals: true,

            // Endpointing and utterance signaling
            interim_results: true,
            // Use 500ms endpointing for Japanese for better stability
            endpointing: storedLanguage === 'ja' ? 500 : ENDPOINTING_MS,
            vad_events: true,
            utterance_end_ms: UTTERANCE_END_MS,
            paragraphs: storedLanguage === 'ja' ? false : true, // Disable paragraphs for Japanese
          };

          // Attach contextual vocabulary (Nova-3 keyterm only, no legacy keywords)
          // IMPORTANT: Don't use keyterms for Japanese - causes connection to close
          const isModelNova3 = modelToUse.toLowerCase().startsWith('nova-3');
          if (isModelNova3 && storedLanguage !== 'ja') {
            const selectedKeyterms = (incomingKeyterms && incomingKeyterms.length > 0)
              ? incomingKeyterms
              : (fallbackKeyterms && fallbackKeyterms.length > 0 ? fallbackKeyterms : undefined);
            if (selectedKeyterms && selectedKeyterms.length > 0) {
              // LIMIT keyterms to prevent URL length issues (too many keyterms can cause 1002 errors)
              const MAX_KEYTERMS = 15;
              const limitedKeyterms = selectedKeyterms.slice(0, MAX_KEYTERMS);
              if (selectedKeyterms.length > MAX_KEYTERMS) {
                console.log(`⚠️ Limiting keyterms from ${selectedKeyterms.length} to ${MAX_KEYTERMS} to prevent URL length issues`);
              }
              
              liveOptions.keyterm = limitedKeyterms;
              // Log ALL raw keyterms received/provided for visibility (no slicing)
              if (Array.isArray(rawClientKeyterms) && rawClientKeyterms.length > 0) {
                const printableRaw = rawClientKeyterms.map(item => (typeof item === 'string' ? item : JSON.stringify(item)));
                console.log(`🧩 Raw client keyterms for session ${sessionId} (${printableRaw.length} total):`, printableRaw.join(', '));
              } else {
                console.log(`🧩 Raw default keyterms for session ${sessionId} (${defaultKeywords.length} total):`, defaultKeywords.join(', '));
              }
              console.log(`🧠 Using ${incomingKeyterms ? 'client-provided' : 'default'} keyterms for session ${sessionId} (${limitedKeyterms.length} of ${selectedKeyterms.length}):`, limitedKeyterms.join(', '));
            }
          } else if (isNova3 && storedLanguage === 'ja') {
            console.log(`🇯🇵 Skipping keyterms for Japanese session ${sessionId} (causes connection issues)`);
          }

          // Only create new connection if we didn't get one from pool
          if (!deepgramConnection) {
            console.log(`🔌 Creating new Deepgram connection for session: ${sessionId}`);
            try {
              deepgramConnection = deepgram.listen.live(liveOptions);
              
              // Track in pool
              connectionPool.active.set(sessionId, {
                connection: deepgramConnection,
                createdAt: Date.now()
              });
            } catch (error) {
              console.error(`❌ Failed to create Deepgram connection:`, error);
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Failed to create Deepgram connection',
                code: 'DEEPGRAM_CONNECTION_FAILED',
                retry: true
              }));
              return;
            }
          }
          
          // Store connection
          deepgramConnections.set(sessionId, deepgramConnection);

          // CRITICAL FIX: Capture sessionId for event handler closures
          // This prevents "null" from appearing in logs after session ends
          const currentSessionId = sessionId;

          // ================================================================
          // FIX #2: Per-Session State Initialization
          // Initialize session state and capture connection ID for stale
          // event detection
          // ================================================================
          const sessionState = getSessionState(currentSessionId);
          sessionState.connection = deepgramConnection;
          sessionState.isConnected = false; // Will be set true on Open event
          const connectionId = sessionState.connectionId; // Capture for closure
          console.log(`📝 Initialized session state for ${currentSessionId}, connectionId: ${connectionId}`);

          // Set up Deepgram event listeners
          deepgramConnection.on(LiveTranscriptionEvents.Open, () => {
            // FIX #2: Stale event detection - ignore events from old connections
            const state = getSessionState(currentSessionId);
            if (!state || state.connectionId !== connectionId) {
              console.log(`⚠️ Ignoring Open event from stale connection: ${connectionId} (current: ${state?.connectionId})`);
              return;
            }
            
            // Update BOTH per-session state AND legacy flag (for backward compatibility)
            state.isConnected = true;
            isDeepgramConnected = true;

            // CRITICAL FIX: Flush any audio that was buffered while waiting for Deepgram to connect
            if (audioRetryQueue.length > 0) {
              console.log(`📤 Flushing ${audioRetryQueue.length} buffered audio chunks now that Deepgram is connected`);
              const queue = [...audioRetryQueue];
              audioRetryQueue = [];
              queue.forEach(queuedBuffer => {
                try {
                  deepgramConnection.send(queuedBuffer);
                } catch (err) {
                  console.error(`❌ Failed to flush buffered audio: ${err.message}`);
                }
              });
            }

            const sessionLang = sessionLanguages.get(currentSessionId) || 'unknown';
            console.log(`🎤 Deepgram connected for session: ${currentSessionId} (language: ${sessionLang}, connId: ${connectionId})`);

            // For Japanese sessions, send multiple keep-alives to ensure connection stability
            if (sessionLang === 'ja') {
              console.log(`🇯🇵 Japanese session detected, sending multiple keep-alives for stability`);
              // Send immediate keep-alive
              try {
                deepgramConnection.keepAlive();
                console.log(`🫀 Sent immediate keep-alive for Japanese session: ${currentSessionId}`);

                // Send another keep-alive after 500ms
                setTimeout(() => {
                  const s = getSessionState(currentSessionId);
                  if (s?.isConnected && s?.connectionId === connectionId) {
                    deepgramConnection.keepAlive();
                    console.log(`🫀 Sent second keep-alive for Japanese session: ${currentSessionId}`);
                  }
                }, 500);

                // And one more after 1 second
                setTimeout(() => {
                  const s = getSessionState(currentSessionId);
                  if (s?.isConnected && s?.connectionId === connectionId) {
                    deepgramConnection.keepAlive();
                    console.log(`🫀 Sent third keep-alive for Japanese session: ${currentSessionId}`);
                  }
                }, 1000);
              } catch (err) {
                console.error(`❌ Failed to send keep-alive for Japanese session: ${err}`);
              }
            } else {
              // Regular keep-alive for non-Japanese sessions
              try {
                deepgramConnection.keepAlive();
                console.log(`🫀 Sent immediate keep-alive for session: ${currentSessionId}`);
              } catch (err) {
                console.error(`❌ Failed to send immediate keep-alive: ${err}`);
              }
            }

            // CRITICAL FIX: Add stabilization delay before signaling client readiness
            // This prevents audio loss at connection start by ensuring connection is fully stable
            setTimeout(() => {
              const s = getSessionState(currentSessionId);
              if (s?.isConnected && s?.connectionId === connectionId && ws.readyState === WebSocket.OPEN) {
                console.log(`✅ Connection stabilized, signaling ready for session: ${currentSessionId}`);
                ws.send(JSON.stringify({
                  type: 'deepgram_connected',
                  sessionId: currentSessionId,
                  provider: 'deepgram',
                  language: sessionLang
                }));
              }
            }, 200); // 200ms stabilization delay

            // Start connection health monitoring
            startConnectionHealthCheck(currentSessionId, ws, deepgramConnection);
          });

          deepgramConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
            // Update connection activity
            updateConnectionActivity(currentSessionId);
            
            // SILENT FAILURE DETECTION: Track ANY Deepgram response (even empty transcripts)
            // This resets on EVERY transcript event, not just those with text content
            const tracking = silentFailureTracking.get(currentSessionId);
            if (tracking) {
              tracking.lastDeepgramResponseTime = Date.now();
              tracking.warningSent = false; // Reset warning since we received a response
            }
            
            // Check if we have the expected structure
            if (data && data.channel && data.channel.alternatives && data.channel.alternatives.length > 0) {
              const transcript = data.channel.alternatives[0].transcript;
              const confidence = data.channel.alternatives[0].confidence;
              
              if (transcript && transcript.trim().length > 0) {
                // Check if this is a final transcript from CloseStream finalization
                const isFromFinalize = data.from_finalize === true;

                if (isFromFinalize) {
                  console.log(`🏁 FINAL TRANSCRIPT from CloseStream for session ${currentSessionId}:`, transcript);
                }

                // Track final transcripts during finalization
                if (data.is_final && finalizationPending.has(currentSessionId)) {
                  const pending = finalizationPending.get(currentSessionId);
                  pending.finalTranscripts.push({
                    transcript,
                    timestamp: Date.now()
                  });
                  pending.lastTranscriptTime = Date.now();

                  console.log(`📝 Tracked final transcript for session ${currentSessionId}:`, transcript);

                  // Reset timeout since we received a transcript
                  const timeout = finalizationTimeouts.get(currentSessionId);
                  if (timeout) {
                    clearTimeout(timeout);
                  }

                  // OPTIMIZED: If this is a speech_final, use short timeout (500ms)
                  // speech_final means user stopped speaking - no more transcripts coming
                  // Otherwise use longer timeout (2s) for non-final transcripts
                  const timeoutMs = data.speech_final ? 500 : 2000;

                  const newTimeout = setTimeout(() => {
                    console.log(`⏰ No more final transcripts for session ${currentSessionId} after ${timeoutMs}ms`);
                    sendFinalizationComplete(currentSessionId, ws);
                  }, timeoutMs);

                  finalizationTimeouts.set(currentSessionId, newTimeout);

                  if (data.speech_final) {
                    console.log(`🏁 speech_final received - using fast ${timeoutMs}ms timeout for session ${currentSessionId}`);
                  }
                }

                // Track when speech_final is received for faster finalization
                if (data.speech_final) {
                  lastSpeechFinalTime.set(currentSessionId, Date.now());
                }

                ws.send(JSON.stringify({
                  type: 'transcript',
                  transcript,
                  is_final: data.is_final,
                  speech_final: data.speech_final,
                  confidence,
                  confidence_accept: data.is_final ? (typeof confidence === 'number' ? confidence >= MIN_FINAL_CONFIDENCE : true) : true,
                  min_confidence: MIN_FINAL_CONFIDENCE,
                  words: data.channel.alternatives[0].words,
                  from_finalize: isFromFinalize,
                  sessionId: currentSessionId
                }));
              }
            }
          });

          deepgramConnection.on(LiveTranscriptionEvents.Metadata, (data) => {
            // SILENT FAILURE DETECTION: Track any Deepgram response
            const tracking = silentFailureTracking.get(currentSessionId);
            if (tracking) {
              tracking.lastDeepgramResponseTime = Date.now();
              tracking.warningSent = false;
            }
            
            ws.send(JSON.stringify({
              type: 'metadata',
              data,
              sessionId: currentSessionId
            }));
          });

          // VAD Events - Also track these as signs Deepgram is responding
          // Wrapped in try-catch to prevent any errors from affecting connection
          deepgramConnection.on(LiveTranscriptionEvents.SpeechStarted, (data) => {
            try {
              // SILENT FAILURE DETECTION: Track any Deepgram response
              const tracking = silentFailureTracking.get(currentSessionId);
              if (tracking) {
                tracking.lastDeepgramResponseTime = Date.now();
                tracking.warningSent = false;
              }
              
              // Forward to client (optional - may be useful for UI feedback)
              if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({
                  type: 'speech_started',
                  data,
                  sessionId: currentSessionId
                }));
              }
            } catch (err) {
              console.warn(`⚠️ Error in SpeechStarted handler: ${err.message}`);
            }
          });

          deepgramConnection.on(LiveTranscriptionEvents.UtteranceEnd, (data) => {
            try {
              // SILENT FAILURE DETECTION: Track any Deepgram response
              const tracking = silentFailureTracking.get(currentSessionId);
              if (tracking) {
                tracking.lastDeepgramResponseTime = Date.now();
                tracking.warningSent = false;
              }
              
              // Forward to client (useful for end-of-speech detection)
              if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({
                  type: 'utterance_end',
                  data,
                  sessionId: currentSessionId
                }));
              }
            } catch (err) {
              console.warn(`⚠️ Error in UtteranceEnd handler: ${err.message}`);
            }
          });

          deepgramConnection.on(LiveTranscriptionEvents.Error, (err) => {
            // FIX #2: Stale event detection - ignore events from old connections
            const state = getSessionState(currentSessionId);
            if (!state || state.connectionId !== connectionId) {
              console.log(`⚠️ Ignoring Error event from stale connection: ${connectionId} (current: ${state?.connectionId})`);
              return;
            }
            
            // ================================================================
            // CRITICAL FIX: Mark connection as disconnected on ANY error!
            // This was missing before, causing heartbeats to dead connections
            // ================================================================
            state.isConnected = false;
            isDeepgramConnected = false;
            
            const sessionLang = sessionLanguages.get(currentSessionId) || 'unknown';
            const usedModel = modelToUse || DEFAULT_MODEL;
            console.error(`❌ Deepgram error for session ${currentSessionId} (language: ${sessionLang}, model: ${usedModel}, connId: ${connectionId}):`, err);
            console.error(`❌ Full error details:`, {
              message: err.message || err,
              code: err.code,
              type: err.type,
              model: usedModel,
              language: sessionLang,
              connectionId: connectionId,
              stack: err.stack
            });
            // Categorize errors for better handling
            const errorCode = err.message?.includes('quota') ? 'QUOTA_EXCEEDED' :
                            err.message?.includes('auth') ? 'AUTH_ERROR' :
                            err.message?.includes('timeout') ? 'TIMEOUT' :
                            err.message?.includes('language') ? 'INVALID_LANGUAGE' :
                            err.message?.includes('model') ? 'MODEL_ERROR' :
                            err.message?.includes('1002') ? 'CONNECTION_REJECTED' :
                            'DEEPGRAM_ERROR';
            
            ws.send(JSON.stringify({
              type: 'error',
              error: err.message,
              sessionId: currentSessionId,
              code: errorCode,
              language: sessionLang,
              // Allow client to retry
              retry: errorCode === 'CONNECTION_REJECTED' || errorCode === 'TIMEOUT'
            }));

            // CRITICAL: For fatal connection errors (1002), auto-cleanup to allow new session
            if (errorCode === 'CONNECTION_REJECTED') {
              console.log(`🔓 Fatal connection error, auto-unlocking session for retry...`);
              
              // Clear heartbeat
              if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
              }
              
              // Track end time for debouncing
              lastSessionEndTime = Date.now();
              
              // Reset session lock to allow new session
              sessionIdLocked = false;
              
              // Notify client they can retry
              ws.send(JSON.stringify({
                type: 'session_error_reset',
                sessionId: currentSessionId,
                message: 'Session reset due to connection error. You can start a new session.',
                code: errorCode
              }));
            }

            // Auto-retry suggestion for transient errors
            if (errorCode === 'TIMEOUT' && !state.isConnected) {
              console.log(`🔄 Attempting to reconnect after timeout...`);
              // Mark for reconnection attempt
              setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: 'reconnect_suggested',
                    sessionId: currentSessionId,
                    message: 'Connection timeout detected, please restart session'
                  }));
                }
              }, 1000);
            }
          });

          deepgramConnection.on(LiveTranscriptionEvents.Close, (closeEvent) => {
            // FIX #2: Stale event detection - ignore events from old connections
            const state = getSessionState(currentSessionId);
            if (!state || state.connectionId !== connectionId) {
              console.log(`⚠️ Ignoring Close event from stale connection: ${connectionId} (current: ${state?.connectionId})`);
              return;
            }
            
            // Update BOTH per-session state AND legacy flag
            state.isConnected = false;
            isDeepgramConnected = false;
            
            const sessionLang = sessionLanguages.get(currentSessionId) || 'unknown';
            const usedModel = modelToUse || DEFAULT_MODEL;
            console.log(`🔚 Deepgram stream closed for session: ${currentSessionId} (language: ${sessionLang}, connId: ${connectionId})`);
            console.log(`⚠️ Connection close details:`, {
              sessionId: currentSessionId,
              language: sessionLang,
              model: usedModel,
              connectionId: connectionId,
              wasConnected: !!deepgramConnections.has(currentSessionId),
              closeCode: closeEvent?.code,
              closeReason: closeEvent?.reason || 'No reason provided',
              timestamp: new Date().toISOString()
            });

            // Stop health check for this connection
            stopConnectionHealthCheck(currentSessionId);

            // Send finalization complete if we were waiting for it
            if (finalizationPending.has(currentSessionId)) {
              console.log(`🎉 Stream closed, sending finalization complete for session: ${currentSessionId}`);
              sendFinalizationComplete(currentSessionId, ws);
            }

            // Notify client that Deepgram stream is closed but WebSocket stays alive
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'deepgram_stream_closed',
                sessionId: currentSessionId,
                message: 'Deepgram stream finalized, ready for next session'
              }));
            }
            
            // Don't delete the connection from the map yet - we might recreate it
            // deepgramConnections.delete(sessionId); // REMOVED - keep for potential restart
          });

          // Start heartbeat monitoring after session is established
          startHeartbeat();
          
          // Confirm session started
          ws.send(JSON.stringify({
            type: 'session_started',
            sessionId
          }));
          break;

        case 'audio_data':
          // Validate audio data format
          if (!data.audio || typeof data.audio !== 'string') {
            console.error(`❌ Invalid audio data format for session ${sessionId}`);
            ws.send(JSON.stringify({
              type: 'error',
              error: 'Invalid audio data format',
              sessionId,
              code: 'INVALID_AUDIO_FORMAT'
            }));
            return;
          }

          // Route audio to appropriate STT provider
          const provider = connectionProviders.get(sessionId) || 'deepgram';
          
          try {
            const buffer = Buffer.from(data.audio, 'base64');
            
            if (provider === 'sarvam' && isSarvamConnected && sarvamWebSocketService) {
              // Send to Sarvam - WebM is supported according to docs!
              await sarvamWebSocketService.sendAudio(sessionId, buffer, 'audio/webm', 16000);
            } else {
              // Send to Deepgram (default/fallback)
              forwardAudioToDeepgram(buffer);
            }
          } catch (error) {
            console.error(`❌ Failed to send audio data for session ${sessionId}:`, error);
            ws.send(JSON.stringify({
              type: 'error',
              error: 'Failed to process audio data',
              sessionId,
              code: 'AUDIO_PROCESSING_ERROR',
              details: error.message,
              provider
            }));
          }
          break;

        case 'end_session':
          // ================================================================
          // FIX #3: Clear Heartbeat in end_session
          // Heartbeat must be stopped FIRST to prevent sending to dead session
          // ================================================================
          
          // CRITICAL FIX: Store sessionId for cleanup BEFORE any operations
          const endingSessionId = sessionId;
          const endingState = getSessionState(endingSessionId);
          
          // Clear per-session heartbeat FIRST
          if (endingState?.heartbeatInterval) {
            clearInterval(endingState.heartbeatInterval);
            endingState.heartbeatInterval = null;
            console.log(`💔 Stopped per-session heartbeat for: ${endingSessionId}`);
          }
          
          // Also clear the shared heartbeat interval
          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
            console.log(`💔 Stopped shared heartbeat for: ${endingSessionId}`);
          }
          
          // Track when this session ended for debouncing (Fix #4)
          lastSessionEndTime = Date.now();
          
          const endProvider = connectionProviders.get(sessionId) || 'deepgram';
          
          if (endProvider === 'sarvam' && sarvamConnection && sarvamWebSocketService) {
            try {
              // Ending Sarvam session
              await sarvamWebSocketService.closeSession(sessionId);
              sttConnections.delete(sessionId);
              sarvamConnection = null;
              isSarvamConnected = false;
            } catch (error) {
              console.error(`❌ Error ending Sarvam session ${sessionId}:`, error);
            }
          } else if (deepgramConnection) {
            try {
              console.log(`🛑 Ending Deepgram session: ${sessionId}`);
              deepgramConnection.finish();
              deepgramConnections.delete(sessionId);
            } catch (error) {
              console.error(`❌ Error ending Deepgram session ${sessionId}:`, error);
            }
          }
          
          // Clean up provider info and language
          connectionProviders.delete(sessionId);
          sessionLanguages.delete(sessionId);
          lastSpeechFinalTime.delete(sessionId); // Clean up speech_final tracking
          silentFailureTracking.delete(sessionId); // Clean up silent failure tracking

          // Stop health check monitor
          stopConnectionHealthCheck(endingSessionId);
          
          // Clean up per-session state (with delay for stale events)
          if (endingSessionId) {
            cleanupSessionState(endingSessionId);
          }

          // Reset sessionId and lock to allow new session on same WebSocket
          sessionId = null;
          sessionIdLocked = false;
          isDeepgramConnected = false;
          isSarvamConnected = false;
          audioRetryQueue = [];
          console.log(`✅ Session ${endingSessionId} ended, WebSocket ready for new session (debounce active for ${200}ms)`);
          break;

        case 'ping':
          // Handle client ping for connection health check
          if (sessionId) {
            ws.send(JSON.stringify({
              type: 'pong',
              sessionId,
              timestamp: Date.now()
            }));
            console.log(`🏓 Responded to ping from session: ${sessionId}`);
          } else {
            // This is expected in persistent mode between recording sessions
            // console.log(`💤 Ping received in idle state (persistent mode)`);
            // Suppressed to reduce log noise - WebSocket is alive but no active recording
          }
          break;

        case 'pong':
          // Client responded to our ping
          isAlive = true;
          if (sessionId) {
            console.log(`💚 Received heartbeat pong from session: ${sessionId}`);
          } else {
            // This is expected in persistent mode between recording sessions
            // console.log(`💤 Pong received in idle state (persistent mode)`);
            // Suppressed to reduce log noise - WebSocket is alive but no active recording
          }
          break;

        case 'keep_alive':
          // Forward KeepAlive to Deepgram
          if (deepgramConnection && isDeepgramConnected) {
            try {
              deepgramConnection.keepAlive();
              console.log(`🫀 Forwarded KeepAlive to Deepgram for session: ${sessionId}`);
            } catch (error) {
              console.error(`❌ Failed to send KeepAlive for session ${sessionId}:`, error);
            }
          }
          break;

        case 'close_stream':
          const closeProvider = connectionProviders.get(sessionId) || 'deepgram';
          
          // Handle Sarvam close stream
          if (closeProvider === 'sarvam' && sarvamConnection && isSarvamConnected && sarvamWebSocketService) {
            try {
              // Sending flush to Sarvam
              await sarvamWebSocketService.flush(sessionId);
              
              // Wait for final transcripts
              setTimeout(() => {
                ws.send(JSON.stringify({
                  type: 'finalization_complete',
                  sessionId,
                  provider: 'sarvam'
                }));
              }, 1000);
              
              ws.send(JSON.stringify({
                type: 'close_stream_sent',
                sessionId,
                provider: 'sarvam'
              }));
            } catch (error) {
              console.error(`❌ Failed to flush Sarvam for session ${sessionId}:`, error);
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Failed to close Sarvam stream',
                sessionId,
                code: 'CLOSE_STREAM_ERROR',
                provider: 'sarvam'
              }));
            }
          } else if (deepgramConnection && isDeepgramConnected) {
            try {
              console.log(`🏁 Sending CloseStream to Deepgram for session: ${sessionId}`);
              
              // Mark this session as pending finalization
              finalizationPending.set(sessionId, {
                startTime: Date.now(),
                finalTranscripts: [],
                lastTranscriptTime: Date.now()
              });
              
              // Send the CloseStream message as per Deepgram docs
              const closeStreamMsg = JSON.stringify({ type: 'CloseStream' });
              deepgramConnection.send(closeStreamMsg);
              
              console.log(`✅ CloseStream message sent for session: ${sessionId}`);
              
              // Notify client that CloseStream was sent
              ws.send(JSON.stringify({
                type: 'close_stream_sent',
                sessionId,
                message: 'Waiting for final transcripts'
              }));
              
              // Set up finalization timeout (10 seconds)
              const finalizationTimeout = setTimeout(() => {
                console.log(`⏰ Finalization timeout reached for session: ${sessionId}`);
                sendFinalizationComplete(sessionId, ws);
              }, 10000); // 10 seconds timeout
              
              finalizationTimeouts.set(sessionId, finalizationTimeout);
              
            } catch (error) {
              console.error(`❌ Failed to send CloseStream for session ${sessionId}:`, error);
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Failed to close Deepgram stream',
                sessionId,
                code: 'CLOSE_STREAM_ERROR'
              }));
            }
          } else {
            console.warn(`⚠️ CloseStream requested but Deepgram not connected for session ${sessionId}`);
            ws.send(JSON.stringify({
              type: 'error',
              error: 'Deepgram not connected',
              sessionId,
              code: 'DEEPGRAM_NOT_CONNECTED'
            }));
          }
          break;

        case 'finalize':
          // Send Finalize message to Deepgram to flush and get final transcripts without closing stream
          // Use per-session state for connection check (not shared isDeepgramConnected)
          const finalizeState = getSessionState(sessionId);
          const isFinalizeConnected = finalizeState?.isConnected || isDeepgramConnected;
          
          if (deepgramConnection && isFinalizeConnected) {
            try {
              console.log(`✅ Sending Finalize to Deepgram for session: ${sessionId}`);

              // Check if speech_final was recently received (within last 3 seconds)
              // If so, Deepgram likely has no more audio to process - use shorter timeout
              const lastSpeechFinal = lastSpeechFinalTime.get(sessionId);
              const timeSinceSpeechFinal = lastSpeechFinal ? Date.now() - lastSpeechFinal : Infinity;
              const recentSpeechFinal = timeSinceSpeechFinal < 3000; // Within 3 seconds

              // Mark this session as pending finalization (reuse same tracking)
              finalizationPending.set(sessionId, {
                startTime: Date.now(),
                finalTranscripts: [],
                lastTranscriptTime: Date.now()
              });

              const finalizeMsg = JSON.stringify({ type: 'Finalize' });
              deepgramConnection.send(finalizeMsg);

              ws.send(JSON.stringify({
                type: 'finalize_sent',
                sessionId,
                message: 'Waiting for final transcripts'
              }));

              // OPTIMIZATION: If speech_final was recently received, use shorter timeout
              // Deepgram docs say Finalize may not return anything if no audio is buffered
              let timeoutMs;
              if (recentSpeechFinal) {
                // speech_final was recent - Deepgram likely has nothing more to process
                timeoutMs = FAST_FINALIZATION_TIMEOUT_MS;
                console.log(`⚡ Fast finalization: speech_final was ${Math.round(timeSinceSpeechFinal)}ms ago, using ${timeoutMs}ms timeout`);
              } else {
                // No recent speech_final - use longer timeout to wait for finals
                timeoutMs = STANDARD_FINALIZATION_TIMEOUT_MS;
                console.log(`⏳ Standard finalization: no recent speech_final, using ${timeoutMs}ms timeout`);
              }

              const finalizeTimeout = setTimeout(() => {
                console.log(`⏰ Finalize timeout reached for session: ${sessionId} (waited ${timeoutMs}ms)`);
                sendFinalizationComplete(sessionId, ws);
              }, timeoutMs);
              finalizationTimeouts.set(sessionId, finalizeTimeout);
            } catch (error) {
              console.error(`❌ Failed to send Finalize for session ${sessionId}:`, error);
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Failed to finalize Deepgram stream',
                sessionId,
                code: 'FINALIZE_ERROR'
              }));
            }
          } else {
            console.warn(`⚠️ Finalize requested but Deepgram not connected for session ${sessionId} (state: ${finalizeState?.isConnected}, legacy: ${isDeepgramConnected})`);
            ws.send(JSON.stringify({
              type: 'error',
              error: 'Deepgram not connected',
              sessionId,
              code: 'DEEPGRAM_NOT_CONNECTED'
            }));
          }
          break;

        default:
          console.log(`❓ Unknown message type: ${data.type}`);
          break;
      }
    } catch (error) {
      console.error('❌ Error processing message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Invalid message format'
      }));
    }
  });

  // Centralized cleanup function
  const cleanupConnection = () => {
    console.log(`🧹 Cleaning up session: ${sessionId}`);
    
    // Clear connection timeout
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
    }
    
    // Clean up Sarvam connection if exists
    if (sarvamConnection && sessionId && sarvamWebSocketService) {
      const provider = connectionProviders.get(sessionId);
      if (provider === 'sarvam') {
        try {
          sarvamWebSocketService.closeSession(sessionId).catch(err => 
            console.error(`❌ Error cleaning up Sarvam session ${sessionId}:`, err)
          );
          sttConnections.delete(sessionId);
        } catch (error) {
          console.error(`❌ Error cleaning up Sarvam session ${sessionId}:`, error);
        }
      }
    }
    
    // Decrement connection count
    currentConnections = Math.max(0, currentConnections - 1);
    console.log(`📊 Connections: ${currentConnections}/${MAX_CONNECTIONS}`);
    
    // Clean up heartbeat interval
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
      console.log(`💔 Stopped heartbeat for session: ${sessionId}`);
    }
    
    // Clean up health check
    if (sessionId) {
      stopConnectionHealthCheck(sessionId);
    }
    
    // Clean up finalization tracking
    if (sessionId) {
      const timeout = finalizationTimeouts.get(sessionId);
      if (timeout) {
        clearTimeout(timeout);
        finalizationTimeouts.delete(sessionId);
      }
      finalizationPending.delete(sessionId);
    }
    
    // Try to return connection to pool instead of closing
    if (deepgramConnection && sessionId) {
      const conn = connectionPool.active.get(sessionId);
      if (conn && Date.now() - conn.createdAt < connectionPool.maxAge) {
        // Connection is still fresh, return to pool
        connectionPool.release(sessionId);
        console.log(`♻️ Returned connection to pool for session: ${sessionId}`);
      } else {
        // Connection too old or not in pool, close it
        try {
          deepgramConnection.finish();
          if (sessionId) {
            deepgramConnections.delete(sessionId);
            connectionPool.active.delete(sessionId);
          }
        } catch (error) {
          console.error(`❌ Error cleaning up session ${sessionId}:`, error);
        }
      }
    }
    
    // CRITICAL FIX: Clean up provider tracking and language (prevents memory leak)
    if (sessionId) {
      connectionProviders.delete(sessionId);
      sessionLanguages.delete(sessionId); // Memory leak fix
      
      // Mark session as stale so Deepgram events from old connections are ignored
      cleanupSessionState(sessionId);
    }

    // Clear audio retry queue
    audioRetryQueue = [];
  };

  // Handle WebSocket close
  ws.on('close', () => {
    console.log(`🔌 WebSocket connection closed for session: ${sessionId}`);
    cleanupConnection();
  });

  // Handle WebSocket errors
  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for session ${sessionId}:`, error);
    cleanupConnection();
  });

  // Send initial connection confirmation
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'WebSocket connection established'
  }));
});

// Handle server events
wss.on('listening', () => {
  console.log(`✅ VRPlaced STT WebSocket Server listening on port ${port}`);
  console.log(`🌍 Server ready to accept connections from allowed origins`);
});

wss.on('error', (error) => {
  console.error('❌ WebSocket server error:', error);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down VRPlaced STT WebSocket Server...');
  
  // Close all active Sarvam connections
  if (sarvamWebSocketService) {
    // Cleaning up Sarvam sessions
    sarvamWebSocketService.cleanup().catch(err => 
      console.error('❌ Error cleaning up Sarvam sessions:', err)
    );
  }
  
  // Close all active Deepgram connections
  console.log(`🧹 Cleaning up ${deepgramConnections.size} Deepgram connections...`);
  deepgramConnections.forEach((connection, sessionId) => {
    try {
      connection.finish();
      console.log(`✅ Cleaned up Deepgram session: ${sessionId}`);
    } catch (error) {
      console.error(`❌ Error cleaning up Deepgram session ${sessionId}:`, error);
    }
  });
  
  // Clean up connection pool
  console.log(`♻️ Cleaning up ${connectionPool.idle.length} pooled connections...`);
  connectionPool.idle.forEach(conn => {
    try {
      conn.connection.finish();
    } catch (error) {
      console.error('Error closing pooled connection:', error);
    }
  });
  connectionPool.active.forEach((conn, sessionId) => {
    try {
      conn.connection.finish();
      console.log(`✅ Cleaned up pooled session: ${sessionId}`);
    } catch (error) {
      console.error(`❌ Error cleaning up pooled session ${sessionId}:`, error);
    }
  });
  
  // Clear rate limit tracking
  rateLimitMap.clear();
  
  // Clear intervals
  clearInterval(rateLimitCleanupInterval);
  
  // Close WebSocket server
  wss.close(() => {
    console.log('✅ WebSocket server closed');
    
    // Close health server
    healthServer.close(() => {
      console.log('✅ Health check server closed');
      process.exit(0);
    });
  });
});

// Sarvam REST API for HTTP fallback
const transcribeWithSarvamRest = async (audioBuffer, options = {}) => {
  if (!sarvamHttpService) {
    throw new Error('Sarvam HTTP service not initialized');
  }
  
  try {
    const result = await sarvamHttpService.transcribeAudio(audioBuffer, {
      language_code: options.language || 'en-IN',
      model: options.model || 'saarika:v2.5',
      keywords: options.keywords || []
    });
    
    return result;
  } catch (error) {
    console.error('❌ Sarvam HTTP transcription failed:', error);
    throw error;
  }
};

// Deepgram REST API for HTTP fallback
const transcribeWithDeepgramRest = async (audioBuffer, options = {}) => {
  try {
    const deepgram = createClient(deepgramApiKey);
    
    // Prepare options
    const transcriptionOptions = {
      model: options.model || DEFAULT_MODEL,
      language: options.language || STT_LANGUAGE,
      smart_format: options.smart_format !== false,
      punctuate: options.punctuate !== false,
      numerals: options.numerals !== false,
    };
    
    // Add keywords/keyterm based on model (Nova 3 uses 'keyterm', others use 'keywords')
    if (options.keywords && Array.isArray(options.keywords)) {
      const isNova3 = transcriptionOptions.model.toLowerCase().includes('nova-3');
      if (isNova3) {
        // Nova 3 uses 'keyterm' parameter
        transcriptionOptions.keyterm = options.keywords;
        console.log('🔍 HTTP: Using keyterms for Nova-3:', options.keywords);
      } else {
        transcriptionOptions.keywords = options.keywords;
        console.log('🔍 HTTP: Using keywords:', options.keywords);
      }
    }
    
    console.log('🎙️ HTTP: Starting Deepgram REST transcription', {
      bufferSize: audioBuffer.length,
      options: transcriptionOptions
    });
    
    // Use Deepgram SDK v4 for REST API
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      audioBuffer,
      transcriptionOptions
    );
    
    if (error) {
      throw error;
    }
    
    // Extract transcript from response
    const transcript = result?.results?.channels?.[0]?.alternatives?.[0];
    
    return {
      transcript: transcript?.transcript || '',
      confidence: transcript?.confidence || 0,
      words: transcript?.words || []
    };
    
  } catch (error) {
    console.error('❌ Deepgram REST API error:', error);
    throw error;
  }
};

// Combined HTTP + WebSocket server (single port for Railway compatibility)
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  
  // Enable CORS for HTTP endpoints
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Type, X-Connection-Mode');
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  if (pathname === '/health') {
    const health = {
      status: 'healthy',
      activeConnections: currentConnections,
      maxConnections: MAX_CONNECTIONS,
      deepgramSessions: deepgramConnections.size,
      connectionPool: {
        active: connectionPool.active.size,
        idle: connectionPool.idle.length
      },
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      timestamp: new Date().toISOString()
    };
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));

  } else if (pathname === '/test-deepgram') {
    // Test Deepgram connectivity from Railway with detailed logging
    console.log('🧪 Testing Deepgram connection...');
    console.log('🔑 API Key (first 8 chars):', deepgramApiKey?.substring(0, 8) + '...');
    const testStartTime = Date.now();
    const events = [];

    try {
      // Create Deepgram client for this test
      const testDeepgram = createClient(deepgramApiKey);
      console.log('✅ Deepgram client created');
      events.push({ time: Date.now() - testStartTime, event: 'client_created' });

      const testConnection = testDeepgram.listen.live({
        model: 'nova-2',
        language: 'en',
        smart_format: false,
        interim_results: false
      });
      console.log('✅ Live connection object created');
      events.push({ time: Date.now() - testStartTime, event: 'connection_object_created' });

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const elapsed = Date.now() - testStartTime;
          console.log(`❌ Deepgram test TIMEOUT after ${elapsed}ms`);
          console.log('📊 Events received:', events);
          try { testConnection.finish(); } catch (e) {}
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: 'Connection timeout - Deepgram did not respond',
            elapsed_ms: elapsed,
            events: events,
            diagnosis: 'No Open/Error/Close event received - possible network block',
            api_key_prefix: deepgramApiKey?.substring(0, 8),
            timestamp: new Date().toISOString()
          }));
        }
      }, 10000); // 10 second timeout

      // Log ALL possible events
      testConnection.on(LiveTranscriptionEvents.Open, () => {
        console.log('🎤 Deepgram Open event received');
        events.push({ time: Date.now() - testStartTime, event: 'OPEN' });
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          const elapsed = Date.now() - testStartTime;
          console.log(`✅ Deepgram test SUCCESS in ${elapsed}ms`);
          try { testConnection.finish(); } catch (e) {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: 'Deepgram connection successful',
            elapsed_ms: elapsed,
            events: events,
            timestamp: new Date().toISOString()
          }));
        }
      });

      testConnection.on(LiveTranscriptionEvents.Error, (err) => {
        console.log('❌ Deepgram Error event:', err);
        events.push({ time: Date.now() - testStartTime, event: 'ERROR', message: err?.message || String(err) });
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          const elapsed = Date.now() - testStartTime;
          console.log(`❌ Deepgram test ERROR in ${elapsed}ms:`, err);
          try { testConnection.finish(); } catch (e) {}
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: err?.message || String(err),
            error_full: JSON.stringify(err),
            elapsed_ms: elapsed,
            events: events,
            diagnosis: 'Deepgram rejected the connection',
            timestamp: new Date().toISOString()
          }));
        }
      });

      testConnection.on(LiveTranscriptionEvents.Close, (closeEvent) => {
        console.log('🔚 Deepgram Close event:', closeEvent);
        events.push({ time: Date.now() - testStartTime, event: 'CLOSE', code: closeEvent?.code, reason: closeEvent?.reason });
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          const elapsed = Date.now() - testStartTime;
          console.log(`⚠️ Deepgram test CLOSED in ${elapsed}ms`);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: 'Connection closed before Open event',
            close_code: closeEvent?.code,
            close_reason: closeEvent?.reason,
            elapsed_ms: elapsed,
            events: events,
            diagnosis: 'Deepgram closed the connection',
            timestamp: new Date().toISOString()
          }));
        }
      });

      testConnection.on(LiveTranscriptionEvents.Metadata, (data) => {
        console.log('📋 Deepgram Metadata event');
        events.push({ time: Date.now() - testStartTime, event: 'METADATA' });
      });

      // Log when connection is actually being made
      console.log('⏳ Waiting for Deepgram events...');
      events.push({ time: Date.now() - testStartTime, event: 'waiting_for_events' });

    } catch (err) {
      const elapsed = Date.now() - testStartTime;
      console.log(`❌ Deepgram test EXCEPTION in ${elapsed}ms:`, err);
      events.push({ time: elapsed, event: 'EXCEPTION', message: err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: err.message,
        stack: err.stack,
        elapsed_ms: elapsed,
        events: events,
        diagnosis: 'Failed to create Deepgram connection object',
        timestamp: new Date().toISOString()
      }));
    }

  } else if (pathname === '/api/transcribe' && req.method === 'POST') {
    // HTTP fallback transcription endpoint
    console.log('📨 HTTP: Received transcription request');
    
    // Determine STT provider from headers or query params
    const httpContext = sttRouter.parseConnectionParams(req.url, req.headers);
    const httpProvider = sttRouter.determineProvider(httpContext);
    console.log(`🎯 HTTP: Using ${httpProvider} provider`);
    
    const form = new multiparty.Form({
      maxFilesSize: 10 * 1024 * 1024 // 10MB max
    });
    
    form.parse(req, async (err, fields, files) => {
      if (err) {
        console.error('❌ HTTP: Form parsing error:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid form data' }));
        return;
      }
      
      try {
        // Get audio file
        const audioFile = files.audio?.[0];
        if (!audioFile) {
          throw new Error('No audio file provided');
        }
        
        // Read audio file
        const audioBuffer = await fs.readFile(audioFile.path);
        
        // Parse options
        const options = {
          model: fields.model?.[0],
          language: fields.language?.[0],
          smart_format: fields.smart_format?.[0] === 'true',
          punctuate: fields.punctuate?.[0] === 'true',
          numerals: fields.numerals?.[0] === 'true',
        };
        
        // Validate language if provided
        if (options.language && !DEEPGRAM_SUPPORTED_LANGUAGES.includes(options.language)) {
          console.warn(`⚠️ HTTP: Unsupported language '${options.language}', using default: ${STT_LANGUAGE}`);
          options.language = STT_LANGUAGE;
        }
        
        // Parse keywords if provided
        if (fields.keywords?.[0]) {
          try {
            options.keywords = JSON.parse(fields.keywords[0]);
            console.log('📝 HTTP: Received keywords:', options.keywords);
          } catch (e) {
            console.warn('Failed to parse keywords:', e);
          }
        } else {
          console.log('📝 HTTP: No keywords provided in request');
        }
        
        // Parse embed parameters from fields
        if (fields.embed?.[0]) {
          httpContext.embed = fields.embed[0] === 'true';
        }
        if (fields.embedType?.[0]) {
          httpContext.embedType = fields.embedType[0];
        }
        
        // Transcribe using appropriate REST API
        let result;
        if (httpProvider === 'sarvam' && sarvamHttpService) {
          // Using Sarvam for HTTP transcription
          try {
            result = await transcribeWithSarvamRest(audioBuffer, options);
          } catch (sarvamError) {
            console.error('❌ HTTP: Sarvam failed, falling back to Deepgram:', sarvamError);
            result = await transcribeWithDeepgramRest(audioBuffer, options);
          }
        } else {
          console.log('🎯 HTTP: Using Deepgram for transcription');
          result = await transcribeWithDeepgramRest(audioBuffer, options);
        }
        
        // Send response
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        
        // Cleanup temp file
        await fs.unlink(audioFile.path).catch(() => {});
        
        console.log('✅ HTTP: Transcription completed', {
          transcriptLength: result.transcript?.length || 0,
          confidence: result.confidence
        });
        
      } catch (error) {
        console.error('❌ HTTP: Transcription error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          error: 'Transcription failed', 
          message: error.message 
        }));
      }
    });
    
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// Handle WebSocket upgrade requests on the same server
server.on('upgrade', (request, socket, head) => {
  // Verify the WebSocket client
  verifyWebSocketClient(
    { req: request, origin: request.headers.origin },
    (allowed, code, message) => {
      if (!allowed) {
        socket.write(`HTTP/1.1 ${code || 403} ${message || 'Forbidden'}\r\n\r\n`);
        socket.destroy();
        return;
      }

      // Upgrade to WebSocket
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  );
});

// Start combined HTTP + WebSocket server on single port
server.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log(`📡 WebSocket: ws://localhost:${port}`);
  console.log(`💊 Health check: http://localhost:${port}/health`);
  console.log(`🌐 HTTP API: http://localhost:${port}/api/transcribe`);
});