const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const socketUtil = require('../utils/socket');
const attendanceService = require('../services/attendanceService');
const RfidConfig = require('../models/RfidConfig');
const { getScanMessage } = require('../utils/scanMessages');
const { normalizeUid } = require('../utils/normalizeUid');

// How long the initial "WELCOME / <name>" LCD message stays up before being replaced by the "TIME IN /
// How long the initial "WELCOME / <name>" LCD message stays up before being replaced by the "TIME IN / SUCCESS" stage
const LCD_STAGE_DELAY_MS = 2000;

// RFID SERVICE - Serial Port Management & Arduino Communication
// Detect available serial ports and identify which (if any) is an Arduino/USB-serial device, using USB VID/PID metadata

let serialPort = null;
let parser = null;
let connectionAttempts = 0;
let currentBaudRate = 9600;
let lastError = null;
let lastConnectedDevice = null;
// Binding-mode session (replaces the old bare boolean)
let bindingSession = { enabled: false, mode: 'register', userId: null, coachId: null, startedAt: null, startedBy: null };
// Back-compat alias
let registrationMode = false;
// Safety net against stuck-ON binding mode: if an admin leaves the Bind modal / Register page open
const BINDING_TIMEOUT_MS = Number(process.env.BINDING_TIMEOUT_MS || 120000);
let bindingTimer = null;

function clearBindingTimer() {
  if (bindingTimer) {
    clearTimeout(bindingTimer);
    bindingTimer = null;
  }
}

function armBindingTimer() {
  clearBindingTimer();
  if (!Number.isFinite(BINDING_TIMEOUT_MS) || BINDING_TIMEOUT_MS <= 0) return;
  bindingTimer = setTimeout(() => {
    bindingTimer = null;
    if (!registrationMode) return;
    console.log(`[RFID] Binding mode auto-OFF after ${BINDING_TIMEOUT_MS}ms with no explicit close (stuck-session safety net)`);
    exports.setRegistrationMode(false);
    try {
      socketUtil.emitToAdmins('rfid:status', exports.getStatus());
    } catch {
      // Non-fatal: expiry must never throw
    }
  }, BINDING_TIMEOUT_MS);
  if (bindingTimer.unref) bindingTimer.unref();
}
// Split-deployment awareness (VPS backend + local scripts/rfidBridge.js)
const BRIDGE_STALE_MS = Number(process.env.BRIDGE_STALE_MS || 12000);
let bridgeLastSeenAt = null;
let bridgeInfo = null;
let lastBound = null;

exports.noteBridgeSeen = (info = {}) => {
  bridgeLastSeenAt = new Date();
  bridgeInfo = { ...info };
};
exports.noteBound = (cardId, ownerId) => {
  lastBound = { cardId, ownerId: ownerId ? String(ownerId) : null, at: new Date() };
};
exports.getLastBound = () => lastBound;

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 3000;

// Known USB vendor/product IDs for Arduino boards and the common USB-to-serial chipsets used on clones
// This is what lets the app say "this is an Arduino" from the device's actual USB identity rather than guessing
const KNOWN_USB_SERIAL_DEVICES = [
  { vendorId: '2341', productId: '0043', name: 'Arduino Uno' },
  { vendorId: '2341', productId: '0001', name: 'Arduino Uno (rev3)' },
  { vendorId: '2341', productId: '0010', name: 'Arduino Mega 2560' },
  { vendorId: '2341', productId: '0042', name: 'Arduino Mega 2560 (rev3)' },
  { vendorId: '2341', productId: '0037', name: 'Arduino Micro' },
  { vendorId: '2341', productId: '0036', name: 'Arduino Leonardo' },
  { vendorId: '2A03', productId: '0043', name: 'Arduino Uno (arduino.org)' },
  { vendorId: '1A86', productId: '7523', name: 'CH340 USB-Serial (common Arduino Nano/Uno clone)' },
  { vendorId: '1A86', productId: '5523', name: 'CH341 USB-Serial' },
  { vendorId: '10C4', productId: 'EA60', name: 'CP210x USB-to-UART Bridge' },
  { vendorId: '0403', productId: '6001', name: 'FTDI FT232 (Arduino Nano/Duemilanove)' },
  { vendorId: '0403', productId: '6015', name: 'FTDI FT231X' },
];

function identifyDevice(port) {
  if (!port.vendorId || !port.productId) return null;
  const vid = port.vendorId.toUpperCase();
  const pid = port.productId.toUpperCase();
  return (
    KNOWN_USB_SERIAL_DEVICES.find(
      (d) => d.vendorId.toUpperCase() === vid && d.productId.toUpperCase() === pid
    ) || null
  );
}

// Config persistence (RfidConfig — single document)

async function getConfig() {
  let config = await RfidConfig.findOne();
  if (!config) config = await RfidConfig.create({});
  return config;
}

async function saveConfig(update) {
  const config = await getConfig();
  Object.assign(config, update);
  await config.save();
  return config;
}

// Does this currently-listed port look like the same physical device we connected to before?
function portMatchesConfig(port, config) {
  if (!config.preferredPort) return false;
  if (port.path !== config.preferredPort) return false;
  if (config.preferredVendorId && port.vendorId !== config.preferredVendorId) return false;
  if (config.preferredProductId && port.productId !== config.preferredProductId) return false;
  if (
    config.preferredSerialNumber &&
    port.serialNumber &&
    port.serialNumber !== config.preferredSerialNumber
  ) {
    return false;
  }
  return true;
}

function httpError(statusCode, message, errorType) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.errorType = errorType;
  return err;
}

// Turns raw serialport open/IO errors into messages an admin can actually act on
function friendlyOpenError(err) {
  const msg = ((err && err.message) || '').toLowerCase();
  if (msg.includes('access denied') || msg.includes('busy') || msg.includes('resource busy')) {
    return 'This port is already in use by another program (e.g. the Arduino IDE Serial Monitor). Close it and try again.';
  }
  if (msg.includes('no such file') || msg.includes('cannot find') || msg.includes('enoent') || msg.includes('does not exist')) {
    return 'This COM port is no longer available. The device may have been unplugged.';
  }
  if (msg.includes('permission')) {
    return 'Permission denied opening this port.';
  }
  return (err && err.message) || 'Failed to open the serial port.';
}

function emitStatus() {
  socketUtil.emitToAdmins('rfid:status', exports.getStatus());
}

// List available serial ports with USB metadata Backs GET /api/rfid/ports

exports.listPorts = async () => {
  const ports = await SerialPort.list();
  return ports.map((port) => {
    const known = identifyDevice(port);
    return {
      path: port.path,
      manufacturer: port.manufacturer || null,
      vendorId: port.vendorId || null,
      productId: port.productId || null,
      serialNumber: port.serialNumber || null,
      friendlyName: known?.name || port.manufacturer || port.pnpId || port.path,
      isArduino: !!known,
    };
  });
};

// Initialize RFID Service (called at server startup)
// If nothing matches, leave the service disconnected — never guess

exports.initRFID = async () => {
  console.log('[RFID] Initializing RFID service...');

  // On the VPS there is no Arduino
  if (String(process.env.RFID_SERIAL_DISABLED || '').toLowerCase() === 'true') {
    console.log('[RFID] Local serial disabled (RFID_SERIAL_DISABLED=true) — expecting rfidBridge.js');
    return;
  }

  try {
    const ports = await SerialPort.list();
    const config = await getConfig();

    let target = null;

    if (config.preferredPort) {
      target = ports.find((p) => portMatchesConfig(p, config));
      if (!target) {
        console.warn(
          `[RFID] Saved port ${config.preferredPort} is gone or no longer matches the saved device. Searching again...`
        );
      }
    }

    if (!target) {
      target = ports.find((p) => identifyDevice(p));
    }

    if (!target) {
      console.warn('[RFID] ⚠️  No Arduino found.');
      console.log('[RFID] Available ports:', ports.map((p) => p.path).join(', ') || '(none)');
      lastError = null;
      emitStatus();
      return;
    }

    console.log(`[RFID] Found Arduino on port: ${target.path}`);
    await exports.connectToPort(target.path, config.baudRate || 9600);
  } catch (err) {
    console.error('[RFID] Initialization error:', err.message);
    lastError = err.message;
    emitStatus();
  }
};

// Connect to an explicit port (auto-detect at startup, or an admin's manual choice via POST /api/rfid/connect)

exports.connectToPort = async (requestedPath, requestedBaudRate) => {
  if (!requestedPath) {
    throw httpError(400, 'port is required', 'missing_port');
  }

  const baudRate = requestedBaudRate ? Number(requestedBaudRate) : currentBaudRate || 9600;
  if (!Number.isInteger(baudRate) || baudRate <= 0) {
    throw httpError(400, 'Invalid baud rate', 'invalid_baud_rate');
  }

  const ports = await SerialPort.list();
  const target = ports.find((p) => p.path === requestedPath);
  if (!target) {
    throw httpError(
      404,
      `Port ${requestedPath} was not found. It may have been unplugged.`,
      'port_unavailable'
    );
  }

  if (serialPort && serialPort.isOpen && serialPort.path === requestedPath && currentBaudRate === baudRate) {
    return exports.getStatus();
  }

  await closeCurrentPort();

  try {
    await new Promise((resolve, reject) => {
    const candidate = new SerialPort({ path: requestedPath, baudRate, autoOpen: false });

    candidate.open((err) => {
      if (err) {
        reject(httpError(409, friendlyOpenError(err), 'port_open_failed'));
        return;
      }

      serialPort = candidate;
      currentBaudRate = baudRate;
      connectionAttempts = 0;
      lastError = null;
      lastConnectedDevice = {
        vendorId: target.vendorId || null,
        productId: target.productId || null,
        serialNumber: target.serialNumber || null,
        friendlyName: identifyDevice(target)?.name || target.manufacturer || target.path,
      };

      console.log(`[RFID] ✓ Connected to ${requestedPath} @ ${baudRate} baud`);

      parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));
      parser.on('data', enqueueRFIDLine);

      exports.sendToArduino(`MODE:${!registrationMode ? 'ATTENDANCE' : bindingSession.mode === 'bind' ? 'BIND' : 'REGISTER'}`);

      serialPort.on('error', (e) => {
        console.error('[RFID] Serial port error:', e.message);
        lastError = friendlyOpenError(e);
        handleDisconnection();
      });

      serialPort.on('close', () => {
        console.log('[RFID] Serial port closed');
        handleDisconnection();
      });

      resolve();
    });
  });
  } catch (err) {
    // Record the failure and broadcast it so every admin UI syncs to the real
    // Record the failure and broadcast it so every admin UI syncs to the real (disconnected) state instead of going stale
    lastError = err?.message || 'Failed to open the serial port.';
    try {
      emitStatus();
    } catch {
      // Non-fatal
    }
    throw err;
  }

  await saveConfig({
    preferredPort: requestedPath,
    preferredVendorId: target.vendorId || null,
    preferredProductId: target.productId || null,
    preferredSerialNumber: target.serialNumber || null,
    baudRate,
  });

  emitStatus();
  return exports.getStatus();
};

// Disconnect the current serial port on admin request Backs POST /api/rfid/disconnect
// Idempotent: disconnecting while already disconnected just returns the current (disconnected) status
exports.disconnectPort = async () => {
  await closeCurrentPort();
  parser = null;
  lastConnectedDevice = null;
  emitStatus();
  return exports.getStatus();
};

function closeCurrentPort() {
  return new Promise((resolve) => {
    const old = serialPort;
    if (old) {
      old.removeAllListeners();
      old.on('error', () => {});
    }
    if (old && old.isOpen) {
      old.close(() => resolve());
    } else {
      serialPort = null;
      resolve();
    }
  });
}

// FUNCTION

// Serial lines are handled strictly one at a time, in the order they arrived
// Without this, a fast tap sequence ran as overlapping async handlers (each awaiting the database)
let scanChain = Promise.resolve();
function enqueueRFIDLine(line) {
  scanChain = scanChain
    .then(() => handleRFIDData(line))
    .catch((err) => console.error('[RFID] Unhandled error while processing a tap:', err && err.message));
  return scanChain;
}

async function handleRFIDData(line) {
  const raw = line.trim();
  // Canonical normalization
  const uid = normalizeUid(line);
  if (!uid) return;

  console.log(`[RFID] Serial incoming: ${raw} → normalized: ${uid}`);

  socketUtil.emitToAdmins('rfid:scanned', { cardId: uid, at: new Date() });

  if (registrationMode) {
    // BINDING MODE
    const ownerId = bindingSession.userId || bindingSession.coachId || null;
    const ownerType = bindingSession.userId ? 'member' : bindingSession.coachId ? 'employee' : null;
    console.log(`[RFID] OPERATION: BINDING (mode=${bindingSession.mode})`);
    console.log(`[RFID] SELECTED MEMBER: ${ownerId || '(none — capture only)'}`);
    console.log(`[RFID] EXISTING RFID MATCH: checking ${uid}...`);

    // The single 'rfid:scanned' broadcast at the top of handleRFIDData already covered bind UIs
    // The single 'rfid:scanned' broadcast at the top of handleRFIDData already covered bind UIs — no second emit here
    if (!ownerId) {
      console.log(`[RFID] Binding mode (capture) — held ${uid} for registration (attendance skipped)`);
      exports.sendToArduino(`Card detected|${uid}`);
      return;
    }

    // Pre-selected owner (EditMember bind modal): auto-bind directly here
    // Idempotent — a repeat tap for the same owner reports success; a UID owned by someone else is rejected as duplicate
    try {
      const RFIDCard = require('../models/RFIDCard');
      const User = require('../models/User');
      const Coach = require('../models/Coach');
      const AuditLog = require('../models/AuditLog');

      const cardLookup = require('./rfidCardLookup');
      const { identityFor } = require('../utils/uidHash');
      const rfidBinding = require('./rfidBinding');
      const existing = await cardLookup.findByUid(uid);
      let reclaimable = null;
      if (existing) {
        const kind = await rfidBinding.classifyExisting(existing, { userId: bindingSession.userId, coachId: bindingSession.coachId });
        if (kind === rfidBinding.KIND.SAME) {
          console.log(`[RFID] Binding idempotent — ${uid} already bound to this ${ownerType}`);
          exports.sendToArduino(`RFID BOUND|${existing.cardId.slice(0, 16)}`);
          socketUtil.emitToAdmins('rfid:bound', { cardId: existing.cardId, ownerId, ownerType, at: new Date() });
          return;
        }
        if (!rfidBinding.isReclaimable(kind)) {
          console.log(`[RFID] Binding rejected — ${uid} already assigned (${kind})`);
          exports.sendToArduino('ALREADY|REGISTERED');
          socketUtil.emitToAdmins('rfid:error', {
            title: 'RFID Already Registered',
            message: rfidBinding.MESSAGES[kind],
            timestamp: new Date(),
            uid,
          });
          return;
        }
        reclaimable = existing;
      }

      let ownerName = '';
      if (bindingSession.userId) {
        const user = await User.findById(bindingSession.userId);
        if (!user) {
          console.log(`[RFID] Binding failed — selected member ${bindingSession.userId} not found`);
          exports.sendToArduino('BIND FAILED|NO MEMBER');
          return;
        }
        ownerName = user.fullname;
      } else {
        const coach = await Coach.findById(bindingSession.coachId);
        if (!coach) {
          console.log(`[RFID] Binding failed — selected employee ${bindingSession.coachId} not found`);
          exports.sendToArduino('BIND FAILED|NO MEMBER');
          return;
        }
        ownerName = coach.fullname;
      }

      let created;
      if (reclaimable) {
        created = await rfidBinding.reclaimOrphan(reclaimable, {
          userId: bindingSession.userId, coachId: bindingSession.coachId, adminId: bindingSession.startedBy, via: 'serial-auto-bind',
        });
      } else {
        created = await RFIDCard.create({
          ...identityFor(uid),
          userId: bindingSession.userId || undefined,
          coachId: bindingSession.coachId || undefined,
          active: true,
          assignedAt: new Date(),
        });
        await AuditLog.create({
          action: 'rfid_register',
          userId: bindingSession.startedBy || undefined,
          meta: { cardId: created.cardId, ownerId, ownerType, via: 'serial-auto-bind' },
        }).catch(() => {});
      }
      if (bindingSession.userId) {
        socketUtil.emitToUser(bindingSession.userId, 'rfid:updated', { bound: true, cardId: created.cardId, active: true });
      }
      socketUtil.emitToAdmins('rfid:bound', { cardId: created.cardId, ownerId, ownerType, at: new Date() });
      console.log(`[RFID] Binding successful — ${created.cardId} → ${ownerName}`);
      exports.sendToArduino(`RFID BOUND|${created.cardId.slice(0, 16)}`);
    } catch (err) {
      console.warn(`[RFID] Binding auto-bind error for ${uid}: ${err.message}`);
      exports.sendToArduino('BIND FAILED|RETRY');
    }
    return;
  }

  try {
    const { action, user } = await attendanceService.processScan(uid);
    console.log(`[RFID] ✓ ${action.toUpperCase()}: ${user.fullname}`);

    const msg = getScanMessage(action === 'checkin' ? 'success_checkin' : 'success_checkout');
    exports.sendToArduino(`${msg.lcdLine1}|${truncateForLcd(user.fullname)}`);
    setTimeout(() => {
      exports.sendToArduino(`${msg.lcdStage2.lcdLine1}|${msg.lcdStage2.lcdLine2}`);
    }, LCD_STAGE_DELAY_MS);
  } catch (err) {
    // processScan already emits admin rfid:error events for every rejection case
    // Stay silent so the TIME IN / TIME OUT confirmation is not overwritten
    if (err.errorType === 'duplicate_signal') {
      console.log(`[RFID] Repeated reader signal for ${uid} ignored (same physical tap)`);
      return;
    }
    console.warn(`[RFID] Scan rejected for ${uid}: ${err.message}`);

    // Distinct line1/line2 per errorType
    const msg = getScanMessage(err.errorType);
    exports.sendToArduino(`${msg.lcdLine1}|${msg.lcdLine2}`);
  }
}

// A 16x2 LCD only has 16 columns per line — this mirrors the sketch's own truncation
function truncateForLcd(text, maxLength = 16) {
  if (!text) return '';
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

// FUNCTION: Handle Disconnection & Auto-Reconnect

// Guards against handleDisconnection() running twice for the same disconnect event
let isHandlingDisconnection = false;

function handleDisconnection() {
  if (isHandlingDisconnection) return;
  isHandlingDisconnection = true;

  console.log('[RFID] Disconnected from Arduino');

  if (serialPort) {
    if (serialPort.isOpen) {
      serialPort.close((err) => {
        if (err) console.warn('[RFID] Error while closing port:', err.message);
      });
    }
    serialPort.removeAllListeners();
    serialPort.on('error', () => {});
    serialPort = null;
  }

  parser = null;
  lastConnectedDevice = null;
  connectionAttempts += 1;
  emitStatus();

  if (connectionAttempts <= MAX_RECONNECT_ATTEMPTS) {
    const delay = RECONNECT_DELAY_MS * connectionAttempts;
    console.log(`[RFID] Retrying in ${delay}ms (attempt ${connectionAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    setTimeout(() => {
      isHandlingDisconnection = false;
      exports.initRFID();
    }, delay);
  } else {
    console.error('[RFID] ❌ Max reconnection attempts reached. Use Refresh + Connect on the Settings page to retry manually.');
    isHandlingDisconnection = false;
  }
}

// Graceful Shutdown

exports.closeRFID = () => {
  if (serialPort && serialPort.isOpen) {
    console.log('[RFID] Closing serial connection...');
    serialPort.close();
  }
};

// Send Message to Arduino

exports.sendToArduino = (message) => {
  if (!serialPort || !serialPort.isOpen || serialPort.writable === false || serialPort.destroyed) {
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

// Toggle Registration Mode Set to true while the Bind RFID Card modal
exports.setRegistrationMode = (enabled, opts = {}) => {
  const on = typeof enabled === 'object' && enabled !== null ? !!enabled.enabled : !!enabled;
  const o = typeof enabled === 'object' && enabled !== null ? enabled : opts;
  registrationMode = on;
  if (on) {
    const mode = o.mode === 'bind' ? 'bind' : 'register';
    bindingSession = {
      enabled: true,
      mode,
      userId: o.userId ? String(o.userId) : null,
      coachId: o.coachId ? String(o.coachId) : null,
      startedAt: new Date(),
      startedBy: o.startedBy ? String(o.startedBy) : null,
    };
  } else {
    bindingSession = { enabled: false, mode: 'register', userId: null, coachId: null, startedAt: null, startedBy: null };
    clearBindingTimer();
  }
  if (on) armBindingTimer();
  console.log(
    `[RFID] Registration mode ${registrationMode ? `ON (${bindingSession.mode}${bindingSession.userId || bindingSession.coachId ? `, owner=${bindingSession.userId || bindingSession.coachId}` : ', capture-only'})` : 'OFF'}`
  );
  exports.sendToArduino(`MODE:${!registrationMode ? 'ATTENDANCE' : bindingSession.mode === 'bind' ? 'BIND' : 'REGISTER'}`);
};

// Get Connection Status

exports.getStatus = () => {
  return {
    connected: !!(serialPort && serialPort.isOpen),
    port: serialPort ? serialPort.path : null,
    baudRate: currentBaudRate,
    connectionAttempts,
    lastError,
    device: lastConnectedDevice,
    registrationMode,
    binding: bindingSession,
    // Split-deployment additions
    bridgeConnected: !!(bridgeLastSeenAt && Date.now() - bridgeLastSeenAt.getTime() < BRIDGE_STALE_MS),
    bridgeLastSeenAt,
    bridge: bridgeInfo,
    scannerReady:
      !!(serialPort && serialPort.isOpen) ||
      !!(bridgeLastSeenAt && Date.now() - bridgeLastSeenAt.getTime() < BRIDGE_STALE_MS),
  };
};