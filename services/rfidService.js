const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const socketUtil = require('../utils/socket');

// ============================================================================
// RFID SERVICE - Serial Port Management & Arduino Communication
// ============================================================================
// 
// Responsibilities:
// 1. Auto-detect Arduino COM port
// 2. Establish serial connection with Arduino
// 3. Parse incoming RFID UIDs
// 4. Validate card registration & membership
// 5. Record attendance (check-in/check-out)
// 6. Broadcast real-time updates via Socket.IO
// 7. Handle disconnections & auto-reconnect
//
// ============================================================================

let serialPort = null;
let parser = null;
let connectionAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 3000;

// Track attendance state (detect check-in vs check-out)
const attendanceState = new Map(); // userId -> { checkIn: Date, checkOut: Date }

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

// ============================================================================
// FUNCTION: Find Arduino Port
// ============================================================================
// 
// Auto-detects Arduino Uno by looking for:
// - Vendor ID: 2341 (Arduino)
// - Product ID: 0043 (Arduino Uno)
// - Or common port names (COM3, /dev/ttyUSB0, etc.)
//

function findArduinoPort(ports) {
  // Priority 1: Look for Arduino with known VID/PID
  const arduinoVID = '2341';
  const arduinoPID = '0043';
  
  const found = ports.find(port => 
    port.vendorId === arduinoVID && port.productId === arduinoPID
  );
  
  if (found) {
    return found;
  }
  
  // Priority 2: Look for common Arduino port patterns
  const patterns = [
    /COM[0-9]+/,           // Windows: COM3, COM4
    /\/dev\/ttyUSB[0-9]+/, // Linux: /dev/ttyUSB0
    /\/dev\/ttyACM[0-9]+/, // Linux: /dev/ttyACM0
    /\/dev\/cu\.usbserial/,// Mac: /dev/cu.usbserial*
    /\/dev\/cu\.usbmodem/, // Mac: /dev/cu.usbmodem*
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

// ============================================================================
// FUNCTION: Connect to Arduino
// ============================================================================
// 
// Establishes serial connection and sets up line-based data parsing.
// Each UID comes on a new line from Arduino.
//

function connectToArduino(comPort) {
  try {
    serialPort = new SerialPort.SerialPort({
      path: comPort,
      baudRate: 9600,  // Must match Arduino sketch (9600)
      autoOpen: false,
    });
    
    // Open the serial port
    serialPort.open((err) => {
      if (err) {
        console.error('[RFID] Failed to open port:', err.message);
        handleDisconnection();
        return;
      }
      
      console.log(`[RFID] ✓ Connected to Arduino on ${comPort}`);
      connectionAttempts = 0;
      
      // Set up line-based parser (each UID is one line)
      parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));
      
      // Listen for incoming data (UID from Arduino)
      parser.on('data', handleRFIDData);
      
      // Handle errors
      serialPort.on('error', (err) => {
        console.error('[RFID] Serial port error:', err.message);
        handleDisconnection();
      });
      
      // Handle port close
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
// 
// Processes incoming UID strings:
// 1. Validate UID format
// 2. Look up card in database
// 3. Check membership status
// 4. Record attendance
// 5. Broadcast via Socket.IO
//

async function handleRFIDData(line) {
  try {
    // Remove whitespace and validate
    const uid = line.trim().toUpperCase();
    
    if (!uid || uid.length === 0) {
      return; // Ignore empty lines
    }
    
    console.log(`[RFID] Received UID: ${uid}`);
    
    // Validate UID format (should be hex characters only)
    if (!/^[0-9A-F]+$/.test(uid)) {
      console.warn(`[RFID] ❌ Invalid UID format: ${uid}`);
      return;
    }
    
    // Find card in database
    const card = await RFIDCard.findOne({ cardId: uid }).populate('userId');
    
    if (!card || !card.active) {
      console.log(`[RFID] ❌ Unknown RFID or inactive`);
      socketUtil.emitToAdmins('rfid:error', {
        uid,
        message: 'Unknown RFID or inactive card',
        timestamp: new Date(),
      });
      return;
    }
    
    // Check if user has active membership
    const now = new Date();
    const subscription = await Subscription.findOne({
      userId: card.userId._id,
      status: 'active',
      endDate: { $gte: now },
    });
    
    if (!subscription) {
      console.log(`[RFID] ❌ No active membership`);
      socketUtil.emitToAdmins('rfid:error', {
        uid,
        userId: card.userId._id,
        fullname: card.userId.fullname,
        message: 'Membership expired or not active',
        timestamp: new Date(),
      });
      return;
    }
    
    // Update last scan time
    card.lastScannedAt = now;
    await card.save();
    
    // Determine check-in or check-out
    const userState = attendanceState.get(card.userId._id.toString()) || {};
    let action = 'checkin';
    let attendance;
    
    if (userState.checkIn && !userState.checkOut) {
      // User already checked in, this is check-out
      action = 'checkout';
      userState.checkOut = now;
      
      // Find today's attendance and update it
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      
      attendance = await Attendance.findOne({
        userId: card.userId._id,
        createdAt: { $gte: startOfDay },
        checkOut: { $exists: false }, // Still open
      });
      
      if (attendance) {
        attendance.checkOut = now;
        await attendance.save();
      }
    } else {
      // Check-in
      action = 'checkin';
      userState.checkIn = now;
      
      attendance = new Attendance({
        userId: card.userId._id,
        rfidCardId: card._id,
        checkIn: now,
      });
      await attendance.save();
    }
    
    // Update state tracking
    attendanceState.set(card.userId._id.toString(), userState);
    
    // Audit log
    await AuditLog.create({
      action: `rfid_${action}`,
      userId: card.userId._id,
      meta: { cardId: uid },
    });
    
    // Log success
    console.log(`[RFID] ✓ ${action.toUpperCase()}: ${card.userId.fullname}`);
    
    // Build response payload
    const attendanceEvent = {
      type: action,
      at: now,
      attendance: {
        _id: attendance._id,
        checkIn: attendance.checkIn,
        checkOut: attendance.checkOut,
      },
      user: {
        _id: card.userId._id,
        fullname: card.userId.fullname,
        email: card.userId.email,
      },
    };
    
    // Broadcast to admins (live feed)
    socketUtil.emitToAdmins('attendance', attendanceEvent);
    
    // Broadcast to member (their own notification)
    socketUtil.emitToUser(card.userId._id, 'attendance', attendanceEvent);
  } catch (err) {
    console.error('[RFID] Error processing UID:', err.message);
    socketUtil.emitToAdmins('rfid:error', {
      message: 'Error processing RFID scan',
      error: err.message,
      timestamp: new Date(),
    });
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
  
  // Attempt reconnection
  connectionAttempts += 1;
  
  if (connectionAttempts <= MAX_RECONNECT_ATTEMPTS) {
    const delay = RECONNECT_DELAY_MS * connectionAttempts;
    console.log(`[RFID] Retrying in ${delay}ms (attempt ${connectionAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    
    setTimeout(() => {
      initRFID();
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
// 
// Can be used to send commands to Arduino (e.g., "REGISTER_MODE", "ATTEND_MODE")
// Not currently implemented but framework is ready.
//

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