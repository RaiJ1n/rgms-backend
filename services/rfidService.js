const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const socketUtil = require('../utils/socket');
const attendanceService = require('../services/attendanceService');

// ============================================================================
// RFID SERVICE - Serial Port Management & Arduino Communication
// ============================================================================
//
// Responsibilities:
// 1. Auto-detect Arduino COM port
// 2. Establish serial connection with Arduino
// 3. Parse incoming RFID UIDs
// 4. Delegate check-in/check-out decisions to attendanceService (shared
//    with the REST /api/rfid/scan fallback, so there's one source of truth)
// 5. Handle disconnections & auto-reconnect
//
// ============================================================================

let serialPort = null;
let parser = null;
let connectionAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 3000;

// ============================================================================
// EXPORT: Initialize RFID Service
// ============================================================================

exports.initRFID = async (io) => {
  console.log('[RFID] Initializing RFID service...');

  try {
    const ports = await SerialPort.SerialPort.list();
    const arduinoPort = findArduinoPort(ports);

    if (!arduinoPort) {
      console.warn('[RFID] ⚠️  No Arduino found. Skipping RFID initialization.');
      console.log('[RFID] Available ports:', ports.map(p => p.path).join(', '));
      return;
    }

    console.log(`[RFID] Found Arduino on port: ${arduinoPort.path}`);
    connectToArduino(arduinoPort.path);
  } catch (err) {
    console.error('[RFID] Initialization error:', err.message);
  }
};

function findArduinoPort(ports) {
  const arduinoVID = '2341';
  const arduinoPID = '0043';

  const found = ports.find(port =>
    port.vendorId === arduinoVID && port.productId === arduinoPID
  );

  if (found) {
    return found;
  }

  const patterns = [
    /COM[0-9]+/,
    /\/dev\/ttyUSB[0-9]+/,
    /\/dev\/ttyACM[0-9]+/,
    /\/dev\/cu\.usbserial/,
    /\/dev\/cu\.usbmodem/,
  ];

  for (const port of ports) {
    for (const pattern of patterns) {
      if (pattern.test(port.path)) {
        return port;
      }
    }
  }

  return null;
}

function connectToArduino(comPort) {
  try {
    serialPort = new SerialPort.SerialPort({
      path: comPort,
      baudRate: 9600,
      autoOpen: false,
    });

    serialPort.open((err) => {
      if (err) {
        console.error('[RFID] Failed to open port:', err.message);
        handleDisconnection();
        return;
      }

      console.log(`[RFID] ✓ Connected to Arduino on ${comPort}`);
      connectionAttempts = 0;

      parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));
      parser.on('data', handleRFIDData);

      serialPort.on('error', (err) => {
        console.error('[RFID] Serial port error:', err.message);
        handleDisconnection();
      });

      serialPort.on('close', () => {
        console.log('[RFID] Serial port closed');
        handleDisconnection();
      });
    });
  } catch (err) {
    console.error('[RFID] Connection error:', err.message);
    handleDisconnection();
  }
}

// ============================================================================
// FUNCTION: Handle RFID Data from Arduino
// ============================================================================
// Delegates the actual check-in/check-out decision to attendanceService,
// the same function the REST /api/rfid/scan fallback uses.
//

async function handleRFIDData(line) {
  const uid = line.trim().toUpperCase();
  if (!uid) return;

  console.log(`[RFID] Received UID: ${uid}`);

  try {
    const { action, user } = await attendanceService.processScan(uid);
    console.log(`[RFID] ✓ ${action.toUpperCase()}: ${user.fullname}`);
  } catch (err) {
    // processScan already emits admin rfid:error events for the
    // "card not found" / "no subscription" cases; this just logs.
    console.warn(`[RFID] Scan rejected for ${uid}: ${err.message}`);
  }
}

// ============================================================================
// FUNCTION: Handle Disconnection & Auto-Reconnect
// ============================================================================

function handleDisconnection() {
  console.log('[RFID] Disconnected from Arduino');

  if (serialPort) {
    try {
      serialPort.close();
    } catch (err) {
      // Port already closed
    }
    serialPort = null;
  }

  parser = null;
  connectionAttempts += 1;

  if (connectionAttempts <= MAX_RECONNECT_ATTEMPTS) {
    const delay = RECONNECT_DELAY_MS * connectionAttempts;
    console.log(`[RFID] Retrying in ${delay}ms (attempt ${connectionAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    setTimeout(() => {
      exports.initRFID();
    }, delay);
  } else {
    console.error('[RFID] ❌ Max reconnection attempts reached. Manual restart required.');
  }
}

// ============================================================================
// EXPORT: Graceful Shutdown
// ============================================================================

exports.closeRFID = () => {
  if (serialPort && serialPort.isOpen) {
    console.log('[RFID] Closing serial connection...');
    serialPort.close();
  }
};

// ============================================================================
// EXPORT: Send Message to Arduino (Future Use)
// ============================================================================

exports.sendToArduino = (message) => {
  if (!serialPort || !serialPort.isOpen) {
    console.warn('[RFID] Serial port not available');
    return false;
  }

  try {
    serialPort.write(`${message}\n`, (err) => {
      if (err) {
        console.error('[RFID] Failed to send message:', err.message);
        return;
      }
      console.log(`[RFID] Sent to Arduino: ${message}`);
    });
    return true;
  } catch (err) {
    console.error('[RFID] Send error:', err.message);
    return false;
  }
};

// ============================================================================
// EXPORT: Get Connection Status
// ============================================================================

exports.getStatus = () => {
  return {
    connected: serialPort && serialPort.isOpen,
    port: serialPort ? serialPort.path : null,
    connectionAttempts,
  };
};