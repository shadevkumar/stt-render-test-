const WebSocket = require('ws');

console.log('🧪 Quick Sarvam Test');

const ws = new WebSocket('ws://localhost:8080?embed=true', {
  headers: { 'Origin': 'http://localhost:3000' }
});

ws.on('open', () => {
  console.log('✅ Connected');
  
  // Send start_session
  ws.send(JSON.stringify({
    type: 'start_session',
    session_id: 'TEST_' + Date.now(),
    embed: true
  }));
  
  // Send some audio after 1 second
  setTimeout(() => {
    // Create a small valid WAV audio buffer
    const audioBuffer = Buffer.alloc(1600, 0); // 100ms of silence
    console.log(`📤 Sending ${audioBuffer.length} bytes of audio`);
    ws.send(audioBuffer);
    
    // Close after 3 seconds
    setTimeout(() => {
      console.log('Closing...');
      ws.close();
    }, 3000);
  }, 1000);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'transcript') {
    console.log('🎤 TRANSCRIPT:', msg.transcript);
    console.log('   From Sarvam:', msg.from_sarvam);
  } else if (msg.type === 'error') {
    console.error('❌ ERROR:', msg.error);
  } else if (msg.provider) {
    console.log(`✅ Provider: ${msg.provider}`);
  }
});

ws.on('close', () => {
  console.log('🔌 Closed');
  process.exit(0);
});