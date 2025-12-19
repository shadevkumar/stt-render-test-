/**
 * Sarvam AI HTTP STT Service
 * Handles REST API-based speech-to-text transcription with Sarvam AI
 */

const https = require('https');
const FormData = require('form-data');

class SarvamHttpService {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl || 'https://api.sarvam.ai/v1';
    this.debug = options.debug || false;
  }

  /**
   * Transcribe audio using Sarvam REST API
   */
  async transcribeAudio(audioBuffer, options = {}) {
    try {
      const {
        language_code = 'en-IN',
        model = 'saarika:v2.5',
        keywords = []
      } = options;

      if (this.debug) {
        console.log('🎙️ [Sarvam HTTP] Starting transcription', {
          bufferSize: audioBuffer.length,
          language_code,
          model,
          keywordsCount: keywords.length
        });
      }

      // Create form data
      const formData = new FormData();
      formData.append('audio', audioBuffer, {
        filename: 'audio.wav',
        contentType: 'audio/wav'
      });
      formData.append('language_code', language_code);
      formData.append('model', model);
      
      // Add keywords if provided
      if (keywords && keywords.length > 0) {
        formData.append('keywords', JSON.stringify(keywords));
      }

      // Make API request
      const response = await this.makeRequest('/speech-to-text', formData);
      
      if (this.debug) {
        console.log('✅ [Sarvam HTTP] Transcription completed:', {
          transcriptLength: response.transcript?.length || 0,
          confidence: response.confidence
        });
      }

      // Map to Deepgram-compatible format
      return {
        transcript: response.transcript || response.text || '',
        confidence: response.confidence || 0.95,
        words: response.words || [],
        language: language_code,
        model: model,
        from_sarvam: true
      };

    } catch (error) {
      console.error('❌ [Sarvam HTTP] Transcription error:', error);
      throw error;
    }
  }

  /**
   * Translate and transcribe audio using Sarvam REST API
   */
  async translateAudio(audioBuffer, options = {}) {
    try {
      const {
        model = 'saaras:v2.5',
        target_language = 'en',
        keywords = []
      } = options;

      if (this.debug) {
        console.log('🌐 [Sarvam HTTP] Starting translation', {
          bufferSize: audioBuffer.length,
          model,
          target_language
        });
      }

      // Create form data
      const formData = new FormData();
      formData.append('audio', audioBuffer, {
        filename: 'audio.wav',
        contentType: 'audio/wav'
      });
      formData.append('model', model);
      formData.append('target_language', target_language);
      
      // Add keywords if provided
      if (keywords && keywords.length > 0) {
        formData.append('keywords', JSON.stringify(keywords));
      }

      // Make API request
      const response = await this.makeRequest('/speech-to-text-translate', formData);
      
      if (this.debug) {
        console.log('✅ [Sarvam HTTP] Translation completed:', {
          transcriptLength: response.transcript?.length || 0,
          translationLength: response.translation?.length || 0
        });
      }

      // Map to Deepgram-compatible format with translation
      return {
        transcript: response.transcript || '',
        translation: response.translation || '',
        confidence: response.confidence || 0.95,
        words: response.words || [],
        source_language: response.source_language || 'auto',
        target_language: target_language,
        model: model,
        from_sarvam: true
      };

    } catch (error) {
      console.error('❌ [Sarvam HTTP] Translation error:', error);
      throw error;
    }
  }

  /**
   * Make HTTP request to Sarvam API
   */
  makeRequest(endpoint, formData) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + endpoint);
      
      const options = {
        method: 'POST',
        headers: {
          'api-subscription-key': this.apiKey,
          ...formData.getHeaders()
        }
      };

      const req = https.request(url, options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(response);
            } else {
              const error = new Error(`Sarvam API error: ${res.statusCode}`);
              error.response = response;
              reject(error);
            }
          } catch (error) {
            reject(new Error(`Failed to parse Sarvam response: ${error.message}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      // Write form data to request
      formData.pipe(req);
    });
  }

  /**
   * Check if Sarvam API is accessible
   */
  async checkHealth() {
    try {
      // Try a simple API call to check connectivity
      // Note: This is a placeholder - adjust based on actual Sarvam health endpoint
      const testAudio = Buffer.from('test');
      await this.transcribeAudio(testAudio, {
        model: 'saarika:v2.5',
        language_code: 'en-IN'
      });
      return true;
    } catch (error) {
      if (this.debug) {
        console.error('❌ [Sarvam HTTP] Health check failed:', error);
      }
      return false;
    }
  }
}

module.exports = SarvamHttpService;