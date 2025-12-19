/**
 * Sarvam AI WebSocket STT Service using Official SDK
 * Handles real-time speech-to-text streaming with Sarvam AI
 */

class SarvamWebSocketService {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.connections = new Map();
    this.debug = options.debug || false;
    this.client = null; // Will be initialized asynchronously
    
    // Initialize Sarvam AI Client asynchronously
    this.initializeClient();
  }

  /**
   * Initialize the Sarvam AI Client using dynamic import
   */
  async initializeClient() {
    try {
      // Use dynamic import for ES6 module
      const { SarvamAIClient } = await import('sarvamai');
      this.client = new SarvamAIClient({
        apiSubscriptionKey: this.apiKey
      });
      if (this.debug) {
        console.log('✅ [Sarvam] SDK client initialized');
      }
    } catch (error) {
      console.error('❌ [Sarvam] Failed to initialize SDK client:', error);
      throw error;
    }
  }

  /**
   * Ensure client is initialized before use
   */
  async ensureClientInitialized() {
    if (!this.client) {
      await this.initializeClient();
    }
    if (!this.client) {
      throw new Error('Sarvam AI client not initialized');
    }
  }

  /**
   * Create a new Sarvam STT streaming session
   */
  async createSession(sessionId, options = {}) {
    try {
      // Ensure client is initialized
      await this.ensureClientInitialized();

      const {
        language_code = 'en-IN',
        model = 'saarika:v2.5',
        high_vad_sensitivity = true,
        vad_signals = true,
        keywords = []
      } = options;

      // Reduce debug logs - only show essential info
      if (this.debug) {
        console.log(`🔌 [Sarvam] Creating session: ${sessionId}`);
      }

      // Create WebSocket connection using official SDK
      const socket = await this.client.speechToTextStreaming.connect({
        'language-code': language_code,
        model: model,
        high_vad_sensitivity: high_vad_sensitivity,
        vad_signals: vad_signals
      });

      // Store connection info
      const connectionInfo = {
        socket,
        sessionId,
        isConnected: true,
        accumulatedText: '',
        lastTranscriptTime: Date.now(),
        options,
        keywords
      };

      this.connections.set(sessionId, connectionInfo);

      if (this.debug) {
        console.log(`✅ [Sarvam] WebSocket connected for session: ${sessionId}`);
      }

      return connectionInfo;
    } catch (error) {
      console.error(`❌ [Sarvam] Failed to create session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Send audio data to Sarvam for transcription
   */
  async sendAudio(sessionId, audioData, encoding = 'audio/wav', sampleRate = 16000) {
    const connection = this.connections.get(sessionId);
    if (!connection || !connection.isConnected) {
      throw new Error(`No active Sarvam connection for session: ${sessionId}`);
    }

    try {
      // Convert various audio data types to Buffer
      let audioBuffer;
      
      if (Buffer.isBuffer(audioData)) {
        audioBuffer = audioData;
      } else if (audioData instanceof ArrayBuffer) {
        audioBuffer = Buffer.from(audioData);
      } else if (audioData instanceof Uint8Array) {
        audioBuffer = Buffer.from(audioData);
      } else if (typeof audioData === 'string') {
        // If it's already base64, use it directly
        audioBuffer = Buffer.from(audioData, 'base64');
      } else {
        console.error(`❌ [Sarvam] Unsupported audio data type: ${typeof audioData}`);
        return;
      }

      // Validate buffer
      if (!audioBuffer || audioBuffer.length === 0) {
        if (this.debug) {
          console.log(`⚠️ [Sarvam] Skipping empty audio buffer for session: ${sessionId}`);
        }
        return;
      }

      // Only log format detection if not WAV (for debugging issues)
      if (this.debug && audioBuffer.length > 0) {
        const header = audioBuffer.slice(0, 12).toString('hex');
        if (!header.startsWith('52494646')) { // Not WAV
          console.log(`⚠️ [Sarvam] Non-WAV audio detected: ${header.substring(0, 8)}`);
        }
      }

      // Ensure audio buffer is properly aligned for 16-bit samples
      // If odd number of bytes, pad with a zero byte
      if (audioBuffer.length % 2 !== 0) {
        if (this.debug) {
          console.log(`⚠️ [Sarvam] Padding odd-length audio buffer (${audioBuffer.length} bytes) for session: ${sessionId}`);
        }
        audioBuffer = Buffer.concat([audioBuffer, Buffer.from([0])]);
      }

      // Convert to base64 as required by Sarvam API
      const base64Audio = audioBuffer.toString('base64');

      // Use SDK's transcribe method
      // IMPORTANT: WebSocket API only accepts 'audio/wav' even if sending other formats
      // The REST API supports WebM but WebSocket is limited
      connection.socket.transcribe({
        audio: base64Audio,
        sample_rate: sampleRate,
        encoding: 'audio/wav'  // Force WAV encoding as per WebSocket requirements
      });
      
      // Removed verbose audio chunk logging
    } catch (error) {
      console.error(`❌ [Sarvam] Failed to send audio for session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Send flush signal to get immediate transcription
   */
  async flush(sessionId) {
    const connection = this.connections.get(sessionId);
    if (!connection || !connection.isConnected) {
      throw new Error(`No active Sarvam connection for session: ${sessionId}`);
    }

    try {
      // SDK doesn't have explicit flush, but we can send empty audio to trigger
      connection.socket.transcribe({
        audio: '',
        sample_rate: 16000,
        encoding: 'audio/wav'
      });
      
      if (this.debug) {
        console.log(`🔄 [Sarvam] Sent flush signal for session: ${sessionId}`);
      }
    } catch (error) {
      console.error(`❌ [Sarvam] Failed to send flush for session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Set up event handlers for Sarvam WebSocket
   * Maps Sarvam events to Deepgram-compatible format
   */
  setupEventHandlers(sessionId, onMessage, onError, onClose) {
    const connection = this.connections.get(sessionId);
    if (!connection) {
      throw new Error(`No connection found for session: ${sessionId}`);
    }

    const { socket } = connection;

    // Handle WebSocket open event
    socket.on('open', () => {
      if (this.debug) {
        console.log(`🟢 [Sarvam] WebSocket opened for session: ${sessionId}`);
      }
    });

    // Handle incoming messages from Sarvam
    socket.on('message', (response) => {
      try {
        // Only log transcripts, not all messages
        if (this.debug && response.type === 'data' && response.data?.transcript) {
          console.log(`📨 [Sarvam] Transcript: "${response.data.transcript}"`);
        }

        // Map Sarvam response to Deepgram format based on response type
        if (response.type === 'data' && response.data) {
          // Sarvam sends transcript in data.transcript
          const transcript = response.data.transcript || '';
          
          // Only send if there's actual text
          if (transcript && transcript.trim().length > 0) {
            const mappedMessage = {
              type: 'transcript',
              transcript: transcript,
              is_final: true, // Sarvam always sends final transcripts
              speech_final: true,
              confidence: 0.95, // Sarvam doesn't send confidence, use default
              sessionId: sessionId,
              from_sarvam: true // Mark as Sarvam origin
            };

            // Update accumulated text
            connection.accumulatedText += (connection.accumulatedText ? ' ' : '') + mappedMessage.transcript;
            connection.lastTranscriptTime = Date.now();

            onMessage(mappedMessage);
          }

        } else if (response.type === 'events' && response.data) {
          // Handle VAD events from Sarvam
          const eventData = response.data;
          
          if (eventData.signal_type === 'START_SPEECH') {
            // VAD signal - speech started
            onMessage({
              type: 'vad_event',
              event: 'speech_start',
              sessionId: sessionId
            });
          } else if (eventData.signal_type === 'END_SPEECH') {
            // VAD signal - speech ended
            onMessage({
              type: 'vad_event',
              event: 'speech_end',
              sessionId: sessionId
            });
          }

        } else if (response.type === 'error' || response.error) {
          onError({
            error: response.message || response.error || 'Sarvam transcription error',
            code: 'SARVAM_ERROR',
            sessionId: sessionId
          });

        } else {
          // Pass through other message types
          onMessage({
            ...response,
            sessionId: sessionId
          });
        }

      } catch (error) {
        console.error(`❌ [Sarvam] Error processing message for session ${sessionId}:`, error);
        onError({
          error: 'Failed to process Sarvam message',
          code: 'PARSE_ERROR',
          sessionId: sessionId
        });
      }
    });

    // Handle errors
    socket.on('error', (error) => {
      console.error(`❌ [Sarvam] WebSocket error for session ${sessionId}:`, error);
      connection.isConnected = false;
      onError({
        error: error.message || 'Sarvam WebSocket error',
        code: 'WEBSOCKET_ERROR',
        sessionId: sessionId
      });
    });

    // Handle connection close
    socket.on('close', (event) => {
      if (this.debug) {
        console.log(`🔌 [Sarvam] WebSocket closed for session ${sessionId}:`, event);
      }
      connection.isConnected = false;
      this.connections.delete(sessionId);
      onClose({
        code: event?.code || 1000,
        reason: event?.reason || 'Connection closed',
        sessionId: sessionId
      });
    });
  }

  /**
   * Close a Sarvam streaming session
   */
  async closeSession(sessionId) {
    const connection = this.connections.get(sessionId);
    if (!connection) {
      return;
    }

    try {
      if (connection.socket && connection.isConnected) {
        // Close the WebSocket using SDK method
        connection.socket.close();
      }
      
      this.connections.delete(sessionId);
      
      if (this.debug) {
        console.log(`✅ [Sarvam] Closed session: ${sessionId}`);
      }
    } catch (error) {
      console.error(`❌ [Sarvam] Error closing session ${sessionId}:`, error);
    }
  }

  /**
   * Get accumulated text for a session
   */
  getAccumulatedText(sessionId) {
    const connection = this.connections.get(sessionId);
    return connection?.accumulatedText || '';
  }

  /**
   * Check if session is connected
   */
  isConnected(sessionId) {
    const connection = this.connections.get(sessionId);
    return connection?.isConnected || false;
  }

  /**
   * Get all active sessions
   */
  getActiveSessions() {
    return Array.from(this.connections.keys());
  }

  /**
   * Clean up all connections
   */
  async cleanup() {
    for (const sessionId of this.connections.keys()) {
      await this.closeSession(sessionId);
    }
  }
}

module.exports = SarvamWebSocketService;