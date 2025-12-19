/**
 * STT Provider Router
 * Intelligently routes between Deepgram and Sarvam based on configuration
 */

class STTProviderRouter {
  constructor(options = {}) {
    this.defaultProvider = options.defaultProvider || 'deepgram';
    this.debug = options.debug || false;
    this.providers = new Map();
  }

  /**
   * Register a provider
   */
  registerProvider(name, provider) {
    this.providers.set(name, provider);
    if (this.debug) {
      console.log(`✅ [Router] Registered STT provider: ${name}`);
    }
  }

  /**
   * Determine which STT provider to use based on context
   */
  determineProvider(context = {}) {
    const {
      embed = false,
      embedType = null,
      sttProvider = null,
      language = 'en',
      forceProvider = null
    } = context;

    // Priority 1: Explicit force provider (for testing)
    if (forceProvider) {
      if (this.debug) {
        console.log(`🎯 [Router] Using forced provider: ${forceProvider}`);
      }
      return forceProvider;
    }

    // Priority 2: Explicit sttProvider parameter
    if (sttProvider) {
      if (this.debug) {
        console.log(`🎯 [Router] Using explicit provider: ${sttProvider}`);
      }
      return sttProvider;
    }

    // Priority 3: Check embed mode
    // DISABLED: No longer using Sarvam for embed mode
    // Use Deepgram for all embed mode requests
    // if (embed === true || embed === 'true') {
    //   if (this.debug) {
    //     console.log(`🎯 [Router] Using Sarvam for embed mode (embed=${embed})`);
    //   }
    //   return 'sarvam';
    // }
    if (embed === true || embed === 'true') {
      if (this.debug) {
        console.log(`🎯 [Router] Embed mode detected but using Deepgram (Sarvam disabled for embed)`);
      }
      // Fall through to continue checking other conditions
    }

    // Priority 4: Language-based routing (future enhancement)
    // Could add logic here to route Indian languages to Sarvam
    if (language && language.startsWith('hi') || language.startsWith('ta') || language.startsWith('te')) {
      if (this.debug) {
        console.log(`🎯 [Router] Using Sarvam for Indian language: ${language}`);
      }
      return 'sarvam';
    }

    // Default: Use Deepgram for backward compatibility
    if (this.debug) {
      console.log(`🎯 [Router] Using default provider: ${this.defaultProvider}`);
    }
    return this.defaultProvider;
  }

  /**
   * Get provider instance
   */
  getProvider(name) {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`STT provider not found: ${name}`);
    }
    return provider;
  }

  /**
   * Route to appropriate provider based on context
   */
  route(context) {
    const providerName = this.determineProvider(context);
    return this.getProvider(providerName);
  }

  /**
   * Parse connection parameters to extract routing context
   * CRITICAL FIX: Added validation and error handling
   */
  parseConnectionParams(url, headers = {}) {
    const context = {
      embed: false,
      embedType: null,
      sttProvider: null,
      language: 'en'
    };

    // Parse URL parameters with validation
    if (url) {
      try {
        // Validate URL format
        if (typeof url !== 'string' || url.length === 0) {
          console.warn('⚠️ [Router] Invalid URL format, using defaults');
          return context;
        }

        const urlObj = new URL(url, 'http://localhost');
        const params = urlObj.searchParams;

        // Validate and sanitize parameters
        const embedParam = params.get('embed');
        if (embedParam !== null) {
          context.embed = embedParam === 'true' || embedParam === '1';
        }

        const embedTypeParam = params.get('embedType') || params.get('embed_type');
        if (embedTypeParam && typeof embedTypeParam === 'string' && embedTypeParam.length < 50) {
          context.embedType = embedTypeParam;
        }

        const sttProviderParam = params.get('sttProvider') || params.get('stt_provider');
        if (sttProviderParam && typeof sttProviderParam === 'string' && sttProviderParam.length < 50) {
          // Validate against known providers
          if (['deepgram', 'sarvam'].includes(sttProviderParam.toLowerCase())) {
            context.sttProvider = sttProviderParam.toLowerCase();
          }
        }

        const languageParam = params.get('language') || params.get('lang');
        if (languageParam && typeof languageParam === 'string' && languageParam.length < 10) {
          // Validate language code format (2-5 chars, alphanumeric with hyphens)
          if (/^[a-z]{2}(-[A-Z]{2})?$/i.test(languageParam)) {
            context.language = languageParam;
          }
        }
      } catch (error) {
        console.error('❌ [Router] Error parsing URL:', error.message);
        // Return default context on error
        return context;
      }
    }

    // Parse headers (can override URL params) with validation
    if (headers && typeof headers === 'object') {
      try {
        if (headers['x-embed-mode'] !== undefined) {
          context.embed = headers['x-embed-mode'] === 'true';
        }
        if (headers['x-embed-type'] && typeof headers['x-embed-type'] === 'string' && headers['x-embed-type'].length < 50) {
          context.embedType = headers['x-embed-type'];
        }
        if (headers['x-stt-provider'] && typeof headers['x-stt-provider'] === 'string') {
          const provider = headers['x-stt-provider'].toLowerCase();
          if (['deepgram', 'sarvam'].includes(provider)) {
            context.sttProvider = provider;
          }
        }
        if (headers['x-language'] && typeof headers['x-language'] === 'string' && headers['x-language'].length < 10) {
          if (/^[a-z]{2}(-[A-Z]{2})?$/i.test(headers['x-language'])) {
            context.language = headers['x-language'];
          }
        }
      } catch (error) {
        console.error('❌ [Router] Error parsing headers:', error.message);
        // Continue with existing context values
      }
    }

    if (this.debug) {
      console.log('📋 [Router] Parsed context:', context);
    }

    return context;
  }

  /**
   * Map keywords between different provider formats
   */
  mapKeywords(keywords, targetProvider) {
    if (!keywords || keywords.length === 0) {
      return [];
    }

    if (targetProvider === 'sarvam') {
      // Sarvam expects plain strings
      return keywords.map(kw => {
        if (typeof kw === 'string') {
          // Remove any weight notation (e.g., "word:1.5" -> "word")
          return kw.split(':')[0].trim();
        }
        return String(kw);
      });
    } else if (targetProvider === 'deepgram') {
      // Deepgram can use weighted keywords
      return keywords.map(kw => {
        if (typeof kw === 'string' && !kw.includes(':')) {
          // Add default weight if not present
          return `${kw}:1.5`;
        }
        return kw;
      });
    }

    return keywords;
  }

  /**
   * Normalize response format across providers
   */
  normalizeResponse(response, sourceProvider) {
    // Ensure consistent format regardless of provider
    const normalized = {
      transcript: response.transcript || response.text || '',
      is_final: response.is_final !== undefined ? response.is_final : true,
      confidence: response.confidence || 0.95,
      words: response.words || [],
      provider: sourceProvider,
      timestamp: Date.now()
    };

    // Add provider-specific fields if present
    if (response.language) {
      normalized.language = response.language;
    }
    if (response.speech_final !== undefined) {
      normalized.speech_final = response.speech_final;
    }

    return normalized;
  }

  /**
   * Get health status of all providers
   */
  async getHealthStatus() {
    const status = {
      timestamp: new Date().toISOString(),
      providers: {}
    };

    for (const [name, provider] of this.providers) {
      try {
        // Check if provider has a health check method
        if (typeof provider.checkHealth === 'function') {
          status.providers[name] = {
            available: await provider.checkHealth(),
            status: 'healthy'
          };
        } else {
          status.providers[name] = {
            available: true,
            status: 'no_health_check'
          };
        }
      } catch (error) {
        status.providers[name] = {
          available: false,
          status: 'error',
          error: error.message
        };
      }
    }

    return status;
  }

  /**
   * Get statistics for routing decisions
   */
  getRoutingStats() {
    // This could be enhanced to track actual routing decisions
    return {
      defaultProvider: this.defaultProvider,
      registeredProviders: Array.from(this.providers.keys()),
      routingRules: [
        'sttProvider=sarvam → sarvam (explicit)',
        'language=hi|ta|te → sarvam (Indian languages)',
        'embed=true → deepgram (SARVAM DISABLED FOR EMBED)',
        'default → deepgram'
      ]
    };
  }
}

module.exports = STTProviderRouter;