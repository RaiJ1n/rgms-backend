const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const socketUtil = require('../utils/socket');
const attendanceService = require('../services/attendanceService');
const RfidConfig = require('../models/RfidConfig');
const { getScanMessage } = require('../utils/scanMessages');

// How long the initial "WELCOME / <name>" LCD message stays up before
// being replaced by the "TIME IN / SUCCESS" stage — matches the 2-second
// timing called out in the spec. This assumes the sketch simply
// redisplays whatever it next receives over serial (the existing
// behavior this file already relied on for every other message); it does
// not require any sketch changes.
const LCD_STAGE_DELAY_MS = 2000;

// ============================================================================
// RFID SERVICE - Serial Port Management & Arduino Communication
// ============================================================================
//
// Responsibilities:
// 1. Detect available serial ports and identify which (if any) is an
//    Arduino/USB-serial device, using USB VID/PID metadata — never a
//    hardcoded COM number.
// 2. Establish a serial connection with a chosen port (auto-detected at
//    startup, or explicitly chosen by an admin via POST /api/rfid/connect).
// 3. Parse incoming RFID UIDs.
// 4. Delegate check-in/check-out decisions to attendanceService (shared
//    with the REST /api/rfid/scan fallback, so there's one source of truth).
// 5. Handle disconnections & auto-reconnect.
// 6. Persist the chosen port (by USB metadata, not just its COM string) so
//    a restart can re-find the same physical device even if Windows
//    assigns it a different COM number.
//
// ============================================================================

let serialPort = null;
let parser = null;
let connectionAttempts = 0;
let currentBaudRate = 9600;
let lastError = null;
let lastConnectedDevice = null; // { vendorId, productId, serialNumber, friendlyName }
// When true, an admin is actively binding/registering a card via the
// Settings or Registration UI. Scans during this window skip the normal
// check-in/out attempt entirely (see handleRFIDData) — otherwise every
// scan of an as-yet-unbound card would fail attendanceService.processScan
// and show "Access Denied" on the Arduino's LCD, which reads like a
// rejected member rather than "this is an expected part of registering."
let registrationMode = false;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 3000;

// ============================================================================
// Known USB vendor/product IDs for Arduino boards and the common
// USB-to-serial chipsets used on clones (CH340/CH341, CP210x, FTDI).
// This is what lets the app say "this is an Arduino" from the device's
// actual USB identity rather than guessing from a COM number — a generic
// `/COM[0-9]+/` regex (the old fallback here) would just as happily match
// an unrelated serial device like a power controller, which is exactly
// the kind of false positive this table exists to avoid.
// ============================================================================
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

// ============================================================================
// Config persistence (RfidConfig — single document)
// ============================================================================

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

// Does this currently-listed port look like the same physical device we
// connected to before? Path match alone isn't enough — Windows can and
// will reassign COM numbers, and a *different* device could end up on the
// old saved path. Requiring the USB metadata to also match (where we have
// it recorded) is what prevents "blindly reconnecting to a saved COM6".
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

// Turns raw serialport open/IO errors into messages an admin can actually
// act on, instead of a bare Node/OS error string.
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

// ============================================================================
// EXPORT: List available serial ports with USB metadata
// ============================================================================
// Backs GET /api/rfid/ports. Returns every port Windows currently reports,
// each flagged with isArduino so the frontend can label recognized devices
// while still letting the admin pick any port manually (covers Arduino
// clones using a chipset not in KNOWN_USB_SERIAL_DEVICES).

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

// ============================================================================
// EXPORT: Initialize RFID Service (called at server startup)
// ============================================================================
// 1. Load the saved config (if any).
// 2. If the saved port is still present AND still matches its saved USB
//    metadata, reconnect to it.
// 3. Otherwise, search the currently listed ports for a recognized
//    Arduino/USB-serial chipset and connect to the first match.
// 4. If nothing matches, leave the service disconnected — never guess.

exports.initRFID = async () => {
  console.log('[RFID] Initializing RFID service...');

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

// ============================================================================
// EXPORT: Connect to an explicit port (auto-detect at startup, or an
// admin's manual choice via POST /api/rfid/connect)
// ============================================================================

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

  // Already connected to this exact port at this baud rate — return the
  // current status instead of closing + reopening the same port. The
  // close/reopen cycle briefly releases the OS handle and the immediate
  // re-open can fail with EBUSY/access-denied (surfaced as 409), which
  // is exactly the self-inflicted "stuck selector" conflict: the
  // service ends up disconnected even though nothing actually changed.
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
      parser.on('data', handleRFIDData);

      // Resync the Arduino's idle screen to the backend's current
      // registrationMode. Covers the case where the backend restarts
      // (registrationMode resets to false in memory) while the Arduino
      // stays powered on and mid-registration — without this it would
      // keep showing "REGISTER MODE" indefinitely since nothing else
      // would tell it otherwise.
      exports.sendToArduino(`MODE:${registrationMode ? 'REGISTER' : 'ATTENDANCE'}`);

      // FIX (kept from the original): both 'error' and 'close' fire on a
      // real disconnect — routing both through the same guarded function
      // avoids double reconnect timers.
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
    // Record the failure and broadcast it so every admin UI syncs to
    // the real (disconnected) state instead of going stale. The
    // service is intentionally left disconnected here — the old port
    // was already closed above and the new open failed — so the next
    // GET /status reflects reality and the frontend Port Selector can
    // retry rather than sitting on a phantom connection.
    lastError = err?.message || 'Failed to open the serial port.';
    try {
      emitStatus();
    } catch {
      // Non-fatal: emitting to sockets must never mask the real error.
    }
    throw err;
  }

  // Persist by USB metadata, not just the COM string — see
  // portMatchesConfig() for why that matters on the next startup.
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

// ============================================================================
// EXPORT: Disconnect the current serial port on admin request
// ============================================================================
// Backs POST /api/rfid/disconnect. Lets the admin cleanly release the
// current port before picking another one, instead of relying solely
// on connectToPort()'s implicit close. Idempotent: disconnecting while
// already disconnected just returns the current (disconnected) status.
exports.disconnectPort = async () => {
  await closeCurrentPort();
  parser = null;
  lastConnectedDevice = null;
  emitStatus();
  return exports.getStatus();
};

function closeCurrentPort() {
  return new Promise((resolve) => {
    if (serialPort && serialPort.isOpen) {
      serialPort.removeAllListeners();
      serialPort.close(() => resolve());
    } else {
      if (serialPort) serialPort.removeAllListeners();
      serialPort = null;
      resolve();
    }
  });
}

// ============================================================================
// FUNCTION: Handle RFID Data from Arduino
// ============================================================================
// Delegates the actual check-in/check-out decision to attendanceService,
// the same function the REST /api/rfid/scan fallback uses.

async function handleRFIDData(line) {
  const uid = line.trim().toUpperCase();
  if (!uid) return;

  console.log(`[RFID] Received UID: ${uid}`);

  // Broadcast every raw tap to admins BEFORE attempting attendance
  // processing. AdminrfidRegistration.vue and AdminSettings.vue both
  // listen for this to auto-fill/display the UID — it has to fire for
  // unregistered cards too, so it can't live inside/after processScan
  // (which only succeeds for cards already registered with an active
  // subscription).
  socketUtil.emitToAdmins('rfid:scanned', { cardId: uid, at: new Date() });

  if (registrationMode) {
    // An admin is actively binding/registering this exact card right now
    // — the UID above already reached them. Deliberately skip the
    // check-in/out attempt: we don't want to accidentally check someone
    // in mid-registration, and the LCD should read as "this is expected",
    // not "Access Denied".
    exports.sendToArduino(`Card registered|${uid}`);
    return;
  }

  try {
    const { action, user } = await attendanceService.processScan(uid);
    console.log(`[RFID] ✓ ${action.toUpperCase()}: ${user.fullname}`);

    // Two-stage LCD display per spec: "WELCOME / <name>" immediately,
    // then "TIME IN / SUCCESS" (or the checkout equivalent) after a
    // short pause, using the SAME "line1|line2" wire format the sketch
    // already parses on every write — nothing about the protocol itself
    // changes, just what gets sent and when. See utils/scanMessages.js
    // for the exact copy and the note on why buzzer codes aren't sent.
    const msg = getScanMessage(action === 'checkin' ? 'success_checkin' : 'success_checkout');
    exports.sendToArduino(`${msg.lcdLine1}|${truncateForLcd(user.fullname)}`);
    setTimeout(() => {
      exports.sendToArduino(`${msg.lcdStage2.lcdLine1}|${msg.lcdStage2.lcdLine2}`);
    }, LCD_STAGE_DELAY_MS);
  } catch (err) {
    // processScan already emits admin rfid:error events for every
    // rejection case; this just logs and drives the LCD.
    console.warn(`[RFID] Scan rejected for ${uid}: ${err.message}`);

    // Distinct line1/line2 per errorType (unknown card, expired
    // subscription, deactivated account, etc.) rather than a single
    // "Access Denied|<reason>" for every case — matches the specific
    // wording the spec calls for per scenario, so the LCD and the
    // admin UI never disagree about why a scan was rejected.
    const msg = getScanMessage(err.errorType);
    exports.sendToArduino(`${msg.lcdLine1}|${msg.lcdLine2}`);
  }
}

// A 16x2 LCD only has 16 columns per line — this mirrors the sketch's own
// truncation (per the comment above) so a very long name doesn't just get
// cut off mid-character by the display; it's clipped consistently here too.
function truncateForLcd(text, maxLength = 16) {
  if (!text) return '';
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

// ============================================================================
// FUNCTION: Handle Disconnection & Auto-Reconnect
// ============================================================================

// Guards against handleDisconnection() running twice for the same
// disconnect event (both 'error' and 'close' fire on a real unplug).
let isHandlingDisconnection = false;

function handleDisconnection() {
  if (isHandlingDisconnection) return;
  isHandlingDisconnection = true;

  console.log('[RFID] Disconnected from Arduino');

  if (serialPort) {
    // `serialPort.close()` called with no callback, on a port the OS
    // already closed (physical unplug), doesn't throw synchronously — it
    // emits a fresh 'error' event instead. Since we're potentially already
    // inside an 'error' handler, that re-emission has nowhere to go and
    // Node kills the process with "Unhandled 'error' event". Checking
    // `isOpen` first, and always passing a callback, avoids that.
    if (serialPort.isOpen) {
      serialPort.close((err) => {
        if (err) console.warn('[RFID] Error while closing port:', err.message);
      });
    }
    serialPort.removeAllListeners();
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
// EXPORT: Send Message to Arduino
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
// EXPORT: Toggle Registration Mode
// ============================================================================
// Set to true while the Bind RFID Card modal (EditMember.vue) or the
// Register New Card page (AdminrfidRegistration.vue) is open. See the
// `registrationMode` comment above for why this changes scan handling.
//
// Also tells the Arduino's LCD idle screen to match, via the sketch's
// MODE: command (see sketch_aug7d.ino's handleModeCommand) — e.g.
// "REGISTER MODE / Tap new card" instead of the normal "Gym Attendance /
// Tap your card". This is a *persistent* idle-screen change, distinct
// from the temporary scan-result messages sent elsewhere in this file
// (those auto-revert after ~4s back to whatever MODE is currently set).
//
// The sketch also supports a separate MODE:BIND, but the backend only
// tracks a single registrationMode boolean shared by both the "Bind RFID
// Card" modal and the "Register New Card" page — so both map to
// MODE:REGISTER here. Splitting that into two distinct modes would need
// setRegistrationMode to take a mode name instead of a boolean; not done
// here since nothing currently calls it with that distinction in mind.
exports.setRegistrationMode = (enabled) => {
  registrationMode = !!enabled;
  console.log(`[RFID] Registration mode ${registrationMode ? 'ON' : 'OFF'}`);
  exports.sendToArduino(`MODE:${registrationMode ? 'REGISTER' : 'ATTENDANCE'}`);
};

// ============================================================================
// EXPORT: Get Connection Status
// ============================================================================

exports.getStatus = () => {
  return {
    connected: !!(serialPort && serialPort.isOpen),
    port: serialPort ? serialPort.path : null,
    baudRate: currentBaudRate,
    connectionAttempts,
    lastError,
    device: lastConnectedDevice,
    registrationMode,
  };
};