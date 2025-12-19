# Deployment Notes - WebSocket Server Fix

## Critical Fix Required

The server needs to be deployed with the following fixes:

1. **Connection pooling temporarily disabled** - Line 463 sets `pooledConn = null` to force fresh connections
2. **deepgram_connected message fix** - Server now sends this message even for pooled connections
3. **All other improvements** from previous commits are included

## What Was Fixed

### Issue
- Client waits for `deepgram_connected` message after sending `start_session`
- When server reuses pooled Deepgram connection, it doesn't send `deepgram_connected`
- Client times out after 5 seconds with "Fresh session timeout" error

### Solution
- Server now always sends `deepgram_connected` when session starts
- Connection pooling temporarily disabled for stability
- Better error handling and logging

## Deployment Steps

1. Deploy the updated `server.js` to production
2. Monitor logs for successful `deepgram_connected` messages
3. Once stable, connection pooling can be re-enabled by removing the `null` assignment on line 463

## Testing

After deployment, test that:
1. First recording works
2. Stopping and starting recording again works (persistent mode)
3. No more "Fresh session timeout" errors

## Note

The client-side fix for persistent mode message handling is already deployed and working correctly. The issue is purely server-side.