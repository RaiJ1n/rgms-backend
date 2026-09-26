const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const socketUtil = require('../utils/socket');
const attendanceService = require('../services/attendanceService');
const RfidConfig = require('../models/RfidConfig');
const { getScanMessage } = require('../utils/scanMessages');
const { normalizeUid } = require('../utils/normalizeUid');

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
// Binding-mode session (replaces the old bare boolean). The backend is the
// single source of truth for "what does the next tap mean" — the frontend
// (EditMember bind modal / Register page) sets this via
// POST /api/rfid/registration-mode, and BOTH the serial path
// (handleRFIDData) and the REST fallback (rfidController.scanCard) route
// off it. Shape:
//   { enabled, mode: 'register'|'bind', userId?, coachId?, startedAt, startedBy }
// `mode` only affects the Arduino idle screen (MODE:REGISTER vs MODE:BIND);
// routing treats both as "binding". `userId`/`coachId` is the pre-selected
// owner (EditMember flow) enabling backend auto-bind so a tap binds even if
// the frontend socket event is delayed/lost. The Register page sets no
// owner (owner picked after the tap) → capture-only.
let bindingSession = { enabled: false, mode: 'register', userId: null, coachId: null, startedAt: null, startedBy: null };
// Back-compat alias — everything historical referenced `registrationMode`.
let registrationMode = false;
// Safety net against stuck-ON binding mode: if an admin leaves the Bind
// modal / Register page open (or closes the tab without the unmount POST
// firing), every subsequent attendance tap would be routed to BINDING and
// already-bound cards would never record attendance — easily misread as
// "not recognized". The timer auto-disables binding after this long;
// every fresh setRegistrationMode(true) refreshes it. Configurable via
// BINDING_TIMEOUT_MS (default 2 minutes — long enough to pick an owner
// and tap, short enough to self-heal a stuck session).
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
      // Non-fatal: expiry must never throw.
    }
  }, BINDING_TIMEOUT_MS);
  if (bindingTimer.unref) bindingTimer.unref();
}
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
      exports.sendToArduino(`MODE:${!registrationMode ? 'ATTENDANCE' : bindingSession.mode === 'bind' ? 'BIND' : 'REGISTER'}`);

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
  const raw = line.trim();
  // Canonical normalization: strips \r\n/whitespace, spaces, dashes,
  // colons; uppercases. Arduino sends "A1B2C3D4" but IDE copy/paste or
  // manual entry may yield "A1 B2 C3 D4" / lowercase / dashes.
  const uid = normalizeUid(line);
  if (!uid) return;

  console.log(`[RFID] Serial incoming: ${raw} → normalized: ${uid}`);

  // Broadcast every raw tap to admins BEFORE attempting attendance
  // processing. AdminrfidRegistration.vue and AdminSettings.vue both
  // listen for this to auto-fill/display the UID — it has to fire for
  // unregistered cards too, so it can't live inside/after processScan
  // (which only succeeds for cards already registered with an active
  // subscription).
  socketUtil.emitToAdmins('rfid:scanned', { cardId: uid, at: new Date() });

  if (registrationMode) {
    // BINDING MODE — the next tap is a registration candidate, NOT an
    // attendance scan. A brand-new/unregistered UID is the EXPECTED case
    // here and must never fall through to processScan (which would reject
    // it as card_unregistered / "RFID NOT REGISTERED").
    const ownerId = bindingSession.userId || bindingSession.coachId || null;
    const ownerType = bindingSession.userId ? 'member' : bindingSession.coachId ? 'employee' : null;
    console.log(`[RFID] OPERATION: BINDING (mode=${bindingSession.mode})`);
    console.log(`[RFID] SELECTED MEMBER: ${ownerId || '(none — capture only)'}`);
    console.log(`[RFID] EXISTING RFID MATCH: checking ${uid}...`);

    // The single 'rfid:scanned' broadcast at the top of handleRFIDData
    // already covered bind UIs — no second emit here, otherwise every
    // bind tap triggers duplicate auto-bind POSTs.
    // No pre-selected owner (Register page: owner picked AFTER the tap) —
    // capture-only. Acknowledge detection; registration happens when the
    // frontend POSTs /api/rfid/register, which then pushes RFID BOUND.
    if (!ownerId) {
      console.log(`[RFID] Binding mode (capture) — held ${uid} for registration (attendance skipped)`);
      exports.sendToArduino(`Card detected|${uid}`);
      return;
    }

    // Pre-selected owner (EditMember bind modal): auto-bind directly here
    // so the tap binds even if the frontend socket round-trip is
    // delayed/lost. Idempotent — a repeat tap for the same owner reports
    // success; a UID owned by someone else is rejected as duplicate.
    // The frontend's own POST /register (triggered by the rfid:scanned
    // event above) may race this; it converges via the same duplicate
    // check (frontend treats "already bound to this member" as success).
    try {
      const RFIDCard = require('../models/RFIDCard');
      const User = require('../models/User');
      const Coach = require('../models/Coach');
      const AuditLog = require('../models/AuditLog');

      const existing = await RFIDCard.findOne({ cardId: uid });
      if (existing) {
        const sameOwner =
          (bindingSession.userId && existing.userId && existing.userId.toString() === String(bindingSession.userId)) ||
          (bindingSession.coachId && existing.coachId && existing.coachId.toString() === String(bindingSession.coachId));
        if (sameOwner) {
          console.log(`[RFID] Binding idempotent — ${uid} already bound to this ${ownerType}`);
          exports.sendToArduino(`RFID BOUND|${uid.slice(0, 16)}`);
          socketUtil.emitToAdmins('rfid:bound', { cardId: uid, ownerId, ownerType, at: new Date() });
        } else {
          console.log(`[RFID] Binding rejected — ${uid} already assigned to another account`);
          exports.sendToArduino('ALREADY|REGISTERED');
          socketUtil.emitToAdmins('rfid:error', {
            title: 'RFID Already Registered',
            message: 'This RFID card is already assigned to another account.',
            timestamp: new Date(),
            uid,
          });
        }
        return;
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

      await RFIDCard.create({
        cardId: uid,
        userId: bindingSession.userId || undefined,
        coachId: bindingSession.coachId || undefined,
        active: true,
        assignedAt: new Date(),
      });
      await AuditLog.create({
        action: 'rfid_register',
        userId: bindingSession.startedBy || undefined,
        meta: { cardId: uid, ownerId, ownerType, via: 'serial-auto-bind' },
      }).catch(() => {});
      if (bindingSession.userId) {
        socketUtil.emitToUser(bindingSession.userId, 'rfid:updated', { bound: true, cardId: uid, active: true });
      }
      socketUtil.emitToAdmins('rfid:bound', { cardId: uid, ownerId, ownerType, at: new Date() });
      console.log(`[RFID] Binding successful — ${uid} → ${ownerName}`);
      exports.sendToArduino(`RFID BOUND|${uid.slice(0, 16)}`);
    } catch (err) {
      console.warn(`[RFID] Binding auto-bind error for ${uid}: ${err.message}`);
      exports.sendToArduino('BIND FAILED|RETRY');
    }
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
// `bindingSession` comment above for why this changes scan handling.
//
// Also tells the Arduino's LCD idle screen to match, via the sketch's
// MODE: command (see sketch_aug7d.ino's handleModeCommand). Distinct idle
// screens per flow:
//   bind modal     → MODE:BIND     ("BIND MODE / Tap new card")
//   register page  → MODE:REGISTER ("REGISTER MODE / Tap new card")
//   neither        → MODE:ATTENDANCE
// A MODE command is a *persistent* idle-screen change, distinct from the
// temporary scan-result messages sent elsewhere in this file (those
// auto-revert after ~4s back to whatever MODE is currently set).
//
// `opts` (optional): { mode: 'bind'|'register', userId?, coachId?,
// startedBy? }. Accepts the legacy bare-boolean call
// (setRegistrationMode(true/false)) for backward compatibility.
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
    binding: bindingSession,
  };
};