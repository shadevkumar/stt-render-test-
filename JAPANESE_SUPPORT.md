# Japanese Language Support - Frontend Integration Guide

## Quick Start

To enable Japanese STT for interviews, pass `language: 'ja'` when starting a session:

```javascript
// WebSocket message for Japanese interview
ws.send(JSON.stringify({
  type: 'start_session',
  sessionId: 'your-session-id',
  language: 'ja'  // Enable Japanese STT
}));
```

## What Changed

- Added optional `language` parameter to `start_session` message
- If not provided, defaults to English (existing behavior unchanged)
- Validates language against Deepgram supported languages
- Language is session-specific (different interviews can use different languages)

## No Changes Required For

- English interviews - continue working exactly as before
- Existing frontend apps - language parameter is optional
- Other STT providers - language routing works with Sarvam too

## HTTP API Support

For HTTP transcription, include language in form data:

```javascript
const formData = new FormData();
formData.append('audio', audioFile);
formData.append('language', 'ja');  // Optional
```

## Supported Language Codes

- `ja` - Japanese
- `en` - English (default)
- `zh` - Chinese
- `ko` - Korean
- Plus 40+ other languages

That's it! Just add `language: 'ja'` to support Japanese interviews.