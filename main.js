require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/db');
const http = require('http');
const socketUtil = require('./utils/socket');
const PORT = process.env.PORT || 4000;

let rfidService = null;
try {
  rfidService = require('./services/rfidService');
} catch (err) {
  console.warn('[SERVER] ⚠️  RFID native module unavailable, serial support disabled:', err.message);
}



// ============================================================================
// SERVER STARTUP SEQUENCE
// ============================================================================
//
// 1. Connect to MongoDB
// 2. Initialize Socket.IO
// 3. Initialize RFID service (Arduino connection)
// 4. Start Express server
//
// ============================================================================

connectDB()
  .then(() => {
    console.log('[SERVER] ✓ MongoDB connected');
    
    // Create HTTP server (required for Socket.IO)
    const server = http.createServer(app);
    
    // Initialize Socket.IO for real-time updates
    const io = socketUtil.init(server);
    console.log('[SERVER] ✓ Socket.IO initialized');
    
    // Initialize RFID service (auto-detect and connect to Arduino)
    // This runs in the background and doesn't block server startup
    if (rfidService) {
      try {
        rfidService.initRFID(io);
        console.log('[SERVER] ✓ RFID service initializing...');
      } catch (err) {
        console.warn('[SERVER] ⚠️  RFID service failed to initialize:', err.message);
        // Don't exit — continue without RFID if Arduino not available
      }
    } else {
      console.log('[SERVER] RFID service skipped (module not available).');
    }
    
    // Start Express server
    server.listen(PORT, () => {
      console.log(`[SERVER] ✓ Express server running on port ${PORT}`);
      console.log(`[SERVER] Client URL: ${process.env.CLIENT_URL || 'http://localhost:5173'}`);
      console.log('[SERVER] ═════════════════════════════════════════');
    });
    
    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n[SERVER] Shutting down gracefully...');

      if (rfidService) {
        try {
          rfidService.closeRFID();
          console.log('[SERVER] ✓ RFID connection closed');
        } catch (err) {
          console.warn('[SERVER] ⚠️  Error closing RFID:', err.message);
        }
      }

      server.close(() => {
        console.log('[SERVER] ✓ HTTP server closed');
        process.exit(0);
      });
      
      // Force exit after 10 seconds
      setTimeout(() => {
        console.error('[SERVER] ❌ Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    });
  })
  .catch((error) => {
    console.error('[SERVER] ❌ Startup failed:', error.message);
    process.exit(1);
  });
    