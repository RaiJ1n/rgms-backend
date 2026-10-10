// scripts/rfidBridge.js
//
// Local serial <-> API bridge for split deployments
// (Arduino on a PC, backend on the VPS behind Nginx).
//
//   Arduino --USB serial--> [this bridge] --HTTPS--> Nginx --> Express --> MongoDB
//   Arduino <--USB serial-- [this bridge] <---------- JSON { lcd:{line1,line2} }
//
// What it does
//   1. Reads UID lines from the Arduino. Only lines that normalize to a real
//      hex UID (8-14 chars) are sent to the server — boot banners, debug
//      text and echoes are logged and ignored (they used to be POSTed as
//      "UIDs").
//   2. POST <API_BASE>/rfid/scan  (x-device-key). The backend decides BIND vs
//      ATTENDANCE and returns lcd:{line1,line2}; we write "line1|line2" back.
//   3. Polls GET <API_BASE>/rfid/device-status. That poll is ALSO the
//      heartbeat that lets the admin UI show "scanner connected" (the VPS has
//      no serial port of its own), and it carries MODE / RFID BOUND updates.
//   4. Reports the REAL failure on the LCD instead of one generic message:
//        network down / timeout / DNS / TLS -> SERVER ERROR | NO RESPONSE
//        HTTP 5xx                            -> SERVER ERROR | HTTP <code>
//        HTTP 401 (bad device key)           -> DEVICE KEY   | REJECTED  (403 = card/subscription denial, shown with its own LCD text)
//        Not a valid UID                     -> READ ERROR   | TRY AGAIN
//      and always prints the exact cause in this console.
//
// Run:   node scripts/rfidBridge.js
// Test:  node scripts/rfidDiagnose.js   (run this FIRST if anything fails)
//
// Config (env vars, or a scripts/bridge.env / backend .env file):
//   API_BASE          default https://api.remerfitnessgym.tech/api
//   RFID_DEVICE_KEY   required — must equal RFID_DEVICE_KEY in the VPS .env
//   SERIAL_PORT       optional — e.g. COM5 or /dev/ttyUSB0 (auto-detects otherwise)
//   BAUD              default 9600 (must match Serial.begin in the sketch)
//   REQUEST_TIMEOUT_MS default 8000
//   BRIDGE_DEBUG=1    print every raw serial line WITH the gap (ms) since the
//                     previous signal for the same card - use it to measure your
//                     reader (see RFID_MULTI_TAP.md)
//   RFID_DEBOUNCE_MS  default 1500 - sliding "same physical tap" window; keep it
//                     equal to the backend value. 0 disables.
//   BRIDGE_QUEUE_MAX  default 10   - taps waiting for the server before new ones
//                     are refused with BUSY (taps are queued, never dropped)
//   BRIDGE_SCAN_ATTEMPTS default 2 - tries per tap on network/5xx failure; every
//                     try carries the SAME scanId, so a retry cannot double-record
//
// Requires Node 18+ (global fetch). Keep it alive with a supervisor
// (PM2 / NSSM / Task Scheduler) — see the deployment notes.

const path = require('path');
const os = require('os');

// Optional env files — never overrides real environment variables.
try {
  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, 'bridge.env') });
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
} catch {
  /* dotenv is optional */
}

if (typeof fetch !== 'function') {
  console.error(`[BRIDGE] Node ${process.version} has no global fetch. Install Node 18 or newer.`);
  console.error('[BRIDGE] (On older Node every tap silently ended in "SERVER ERROR / NO RESPONSE".)');
  process.exit(1);
}

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
// ONE normalizer shared with the backend, so "UID: 41 9A 4E 16", "0x419a4e16"
// and "419A4E16" are all treated identically on both sides.
const { normalizeUid, isValidUid } = require('../utils/normalizeUid');
const { TapDebouncer } = require('../utils/tapDebouncer');

const API_BASE = (process.env.API_BASE || 'https://api.remerfitnessgym.tech/api').replace(/\/$/, '');
const DEVICE_KEY = process.env.RFID_DEVICE_KEY || '';
const BAUD = Number(process.env.BAUD || 9600);
const PREFERRED_PORT = process.env.SERIAL_PORT || null;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 8000);
const DEBUG = process.env.BRIDGE_DEBUG === '1';
const BRIDGE_ID = process.env.BRIDGE_ID || os.hostname();
const BRIDGE_VERSION = '2.1';
const envInt = (name, fallback, min, max) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== '' && process.env[name] !== undefined
    ? Math.min(max, Math.max(min, Math.floor(n)))
    : fallback;
};
const DEBOUNCE_MS = envInt('RFID_DEBOUNCE_MS', 1500, 0, 30000);
const QUEUE_MAX = envInt('BRIDGE_QUEUE_MAX', 10, 1, 100);
const SCAN_ATTEMPTS = envInt('BRIDGE_SCAN_ATTEMPTS', 2, 1, 5);
const TAP_MAX_AGE_MS = 20000; // a queued tap older than this is stale (member has walked away)
const POLL_IDLE_MS = 3000;
const POLL_BIND_MS = 1000;

if (!DEVICE_KEY) {
  console.error('[BRIDGE] Missing RFID_DEVICE_KEY. Set it to the same value as the VPS backend .env.');
  process.exit(1);
}

let port = null;
let currentPortPath = null;
let lastMode = null;
const debouncer = new TapDebouncer(DEBOUNCE_MS); // sliding same-tap window
const tapQueue = [];
let pumping = false;
let lastBoundAt = null; // last bind timestamp already handled
let boundBaselineSet = false;
let suppressBoundUntil = 0;
let pollTimer = null;

// HTTP header values must be plain ASCII. A PC hostname such as "Raijin’s-PC"
// (curly apostrophe) makes fetch() throw a TypeError BEFORE anything is sent,
// which used to surface on the LCD as SERVER ERROR / NO RESPONSE for every tap.
const headerSafe = (v) => String(v || '').replace(/[^\x20-\x7E]/g, '?').slice(0, 100);

const baseHeaders = () => ({
  'Content-Type': 'application/json',
  'x-device-key': DEVICE_KEY.trim(),
  'x-bridge-id': headerSafe(BRIDGE_ID),
  'x-bridge-version': BRIDGE_VERSION,
  'x-bridge-serial': headerSafe(currentPortPath),
});

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[BRIDGE ${ts()}]`, ...a);
const warn = (...a) => console.warn(`[BRIDGE ${ts()}]`, ...a);

// ---------------------------------------------------------------------------
// HTTP with a hard timeout + precise error classification
// ---------------------------------------------------------------------------
async function api(method, endpoint, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method,
      headers: baseHeaders(),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON (e.g. Nginx HTML error page) */
    }
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    const cause = err && err.cause ? err.cause : err;
    // AbortError is a DOMException whose numeric `.code` is 20 — check the name first.
    const code = err.name === 'AbortError' ? 'TIMEOUT' : (typeof cause.code === 'string' && cause.code) || err.name || 'FETCH_FAILED';
    const e = new Error(`${code}${cause.message ? ` — ${cause.message}` : ''}`);
    e.code = code;
    e.network = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function networkHint(code) {
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'DNS cannot resolve the API host. Check API_BASE and this PC\'s internet/DNS.';
    case 'ECONNREFUSED':
      return 'Nothing is listening at that address/port (Nginx or the Node app is down, or wrong port).';
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
      return 'Connection dropped mid-request (Nginx/PM2 restart, or a proxy/firewall cut it).';
    case 'TIMEOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
      return `No answer within ${REQUEST_TIMEOUT_MS}ms (VPS firewall, Nginx proxy_read_timeout, or backend hung).`;
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'TLS/SSL certificate problem on the API domain (expired cert or wrong domain).';
    default:
      return 'Run: node scripts/rfidDiagnose.js';
  }
}

// ---------------------------------------------------------------------------
// Serial
// ---------------------------------------------------------------------------
const KNOWN_IDS = new Set([
  '2341:0043', '2341:0001', '2341:0010', '2341:0042', '2341:0037', '2341:0036',
  '2A03:0043', '1A86:7523', '1A86:5523', '10C4:EA60', '0403:6001', '0403:6015',
]);

async function pickPort() {
  const ports = await SerialPort.list();
  if (PREFERRED_PORT) {
    const found = ports.find((p) => p.path === PREFERRED_PORT);
    if (!found) {
      throw new Error(`SERIAL_PORT ${PREFERRED_PORT} not found. Available: ${ports.map((p) => p.path).join(', ') || '(none)'}`);
    }
    return found.path;
  }
  const match = ports.find(
    (p) => p.vendorId && p.productId && KNOWN_IDS.has(`${String(p.vendorId).toUpperCase()}:${String(p.productId).toUpperCase()}`)
  );
  if (match) return match.path;
  if (ports.length === 1) return ports[0].path;
  throw new Error(`No Arduino auto-detected. Available: ${ports.map((p) => p.path).join(', ') || '(none)'}. Set SERIAL_PORT.`);
}

function writeLine(text) {
  return new Promise((resolve) => {
    if (!port || !port.isOpen) return resolve(false);
    port.write(`${text}\n`, (err) => {
      if (err) warn('Serial write failed:', err.message);
      resolve(!err);
    });
  });
}

let reconnecting = false;
function scheduleReconnect(reason) {
  if (reconnecting) return;
  reconnecting = true;
  warn(`Serial unavailable (${reason}). Retrying every 3s — the process stays alive.`);
  const attempt = async () => {
    try {
      await openSerial();
      reconnecting = false;
    } catch (e) {
      warn(`Serial retry failed: ${e.message}`);
      setTimeout(attempt, 3000);
    }
  };
  setTimeout(attempt, 3000);
}

async function openSerial() {
  const p = await pickPort();
  currentPortPath = p;
  log(`Opening ${p} @ ${BAUD}`);
  await new Promise((resolve, reject) => {
    const sp = new SerialPort({ path: p, baudRate: BAUD, autoOpen: false });
    sp.open((err) => {
      if (err) {
        const hint = /access denied|busy|EBUSY|locked/i.test(err.message)
          ? ' — the COM port is held by another program (Arduino IDE Serial Monitor, or a LOCAL backend that auto-connects to the Arduino). Close it.'
          : '';
        return reject(new Error(`Could not open ${p}: ${err.message}${hint}`));
      }
      port = sp;
      const parser = sp.pipe(new ReadlineParser({ delimiter: '\n' }));
      parser.on('data', handleSerialLine);
      sp.on('error', (e) => warn('Serial error:', e.message));
      sp.on('close', () => {
        port = null;
        scheduleReconnect('port closed / Arduino unplugged');
      });
      log('Serial open. Tap a card.');
      lastMode = null; // force MODE re-sync after (re)connect
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Tap handling
// ---------------------------------------------------------------------------
// One id per PHYSICAL tap. Every retry of that tap reuses it, which is what lets
// the server recognise "same tap, again" and return the original result.
let tapSeq = 0;
function makeScanId() {
  const host = headerSafe(BRIDGE_ID).replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'bridge';
  const rand = Math.random().toString(36).slice(2, 8);
  tapSeq = (tapSeq + 1) % 1e6;
  return `${host}-${Date.now().toString(36)}-${tapSeq.toString(36)}-${rand}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reads a serial line and decides: not a UID / repeated signal of the tap that
// is already being handled / a NEW tap (queued). It never talks to the server
// itself, so a slow request can never make it miss the next tap.
function handleSerialLine(rawLine) {
  const raw = String(rawLine || '').replace(/\r/g, '').trim();
  if (!raw) return;

  const uid = normalizeUid(raw);
  const t = Date.now();

  if (!isValidUid(uid)) {
    if (DEBUG) log(`serial RX: ${JSON.stringify(raw)}`);
    // Boot banner / debug output / echo of our own MODE: command, etc.
    log(`Arduino says (not a UID, ignored): ${JSON.stringify(raw.slice(0, 60))}`);
    return;
  }

  // Sliding window: EVERY signal (kept or ignored) moves the window forward, so
  // a card resting on the reader and re-sending is one tap, while a card that
  // was lifted (quiet for >= DEBOUNCE_MS) and tapped again is a new tap.
  const { isNewTap, gap } = debouncer.observe(uid, t);
  if (DEBUG) log(`serial RX: ${JSON.stringify(raw)}${gap === null ? '' : ` (+${gap}ms since last signal for this card)`}`);
  if (!isNewTap) {
    log(`Repeated signal for ${uid} ignored (+${gap}ms < ${DEBOUNCE_MS}ms): same physical tap`);
    return; // silent on the LCD on purpose - the previous result is still on screen
  }

  if (tapQueue.length >= QUEUE_MAX) {
    warn(`Tap ${uid} refused — ${tapQueue.length} taps already waiting for the server`);
    writeLine('BUSY|TRY AGAIN');
    return;
  }
  const tap = { uid, raw, scanId: makeScanId(), at: t };
  tapQueue.push(tap);
  log(`NEW TAP ${uid}${gap === null ? '' : ` (+${gap}ms)`} scanId=${tap.scanId} queued=${tapQueue.length}`);
  pump();
}

// Sends queued taps one at a time, IN ORDER. Taps that arrive during a request
// wait here (they used to be dropped with "PLEASE WAIT").
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (tapQueue.length) await sendTap(tapQueue.shift());
  } finally {
    pumping = false;
  }
}

async function sendTap(tap) {
  const { uid, raw, scanId } = tap;
  if (Date.now() - tap.at > TAP_MAX_AGE_MS) {
    warn(`Tap ${uid} (scanId=${scanId}) is ${Math.round((Date.now() - tap.at) / 1000)}s old — dropped as stale, please tap again`);
    await writeLine('TAP EXPIRED|TAP AGAIN');
    return;
  }

  let r = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= SCAN_ATTEMPTS; attempt += 1) {
    try {
      log(`UID read from Arduino: ${raw} -> ${uid}  => POST ${API_BASE}/rfid/scan (attempt ${attempt}/${SCAN_ATTEMPTS})`);
      // Same scanId on every attempt: if attempt 1 actually reached the server
      // and only the response was lost, the retry returns that result.
      r = await api('POST', '/rfid/scan', { cardId: uid, scanId });
      lastErr = null;
      if (r.status < 500 && !(!r.json && !r.ok)) break; // a real answer
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (err) {
      lastErr = err;
      r = null;
    }
    if (attempt < SCAN_ATTEMPTS) {
      warn(`Attempt ${attempt} failed (${lastErr.message}) — retrying the same tap (scanId=${scanId})`);
      await sleep(400);
    }
  }

  try {
    if (!r) {
      warn(`API unreachable: ${lastErr && lastErr.message}`);
      warn(`Hint: ${networkHint(lastErr && lastErr.code)}`);
      await writeLine('SERVER ERROR|NO RESPONSE');
      return;
    }
    const body = r.json || {};
    log(`HTTP ${r.status} action=${body.action || '-'}${body.replayed ? ' (replayed)' : ''}${body.duplicate ? ' (duplicate)' : ''} bindingMode=${body.bindingMode === true} bound=${body.bound === true} msg=${JSON.stringify(body.message || '')}`);

    // Only 401 means the device key failed (requireDeviceKey). 403 is a normal
    // business denial from the scan flow (deactivated card, expired/no
    // subscription, completed day...) and carries its own LCD text below.
    if (r.status === 401) {
      warn(`Server REJECTED the device key (${body.errorCode || 'no errorCode'}). RFID_DEVICE_KEY here != RFID_DEVICE_KEY in the VPS .env.`);
      await writeLine('DEVICE KEY|REJECTED');
      return;
    }
    if (r.status >= 500 || (!r.json && !r.ok)) {
      warn(`Server-side failure HTTP ${r.status}. Body: ${String(r.text).slice(0, 200).replace(/\s+/g, ' ')}`);
      warn(r.status === 502 || r.status === 504
        ? 'Nginx reached no working Node process (502) or timed out (504): check `pm2 status` and the Nginx upstream port.'
        : r.status === 500
          ? 'Backend threw (or RFID_DEVICE_KEY is unset on the VPS). Check `pm2 logs`.'
          : 'Unexpected response.');
      await writeLine(`SERVER ERROR|HTTP ${r.status}`);
      return;
    }

    // The server says this was only the reader repeating a tap it already
    // handled: leave the display alone.
    if (body.silent) {
      log(`Server ignored a repeated signal for ${uid} (display left unchanged)`);
      return;
    }

    const lcd = body.lcd;
    if (lcd && lcd.line1) {
      await writeLine(`${lcd.line1}|${lcd.line2 || ''}`);
      if (lcd.line1 === 'RFID BOUND') suppressBoundUntil = Date.now() + 6000;
      // If another tap is already waiting, skip the delayed second screen so it
      // cannot be painted over that tap's own result.
      if (lcd.stage2 && lcd.stage2.lcdLine1) {
        setTimeout(() => {
          if (!tapQueue.length) writeLine(`${lcd.stage2.lcdLine1}|${lcd.stage2.lcdLine2 || ''}`);
        }, 2000);
      }
    } else if (body.message) {
      await writeLine(`${String(body.message).slice(0, 16)}|`);
    }
    if (body.bindingMode && body.bound === false && body.data) {
      log(`Binding tap captured: ${uid} (waiting for the admin UI to pick the member)`);
    }
  } catch (err) {
    warn(`Could not finish handling tap ${uid}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Heartbeat + mode sync + bind confirmation
// ---------------------------------------------------------------------------
async function pollStatus() {
  let nextDelay = POLL_IDLE_MS;
  try {
    const r = await api('GET', '/rfid/device-status');
    if (r.status === 401 || r.status === 403) {
      warn('device-status: device key rejected (heartbeat failing — admin UI will show scanner offline).');
    } else if (!r.ok) {
      warn(`device-status: HTTP ${r.status}`);
    } else {
      const d = r.json && r.json.data;
      const b = (d && d.binding) || {};
      const enabled = !!(d && (d.registrationMode || b.enabled));
      const mode = !enabled ? 'ATTENDANCE' : b.mode === 'bind' ? 'BIND' : 'REGISTER';
      if (enabled) nextDelay = POLL_BIND_MS;
      if (mode !== lastMode) {
        lastMode = mode;
        log(`Mode -> ${mode}`);
        await writeLine(`MODE:${mode}`);
      }
      // RFID BOUND confirmation for binds completed via the admin UI
      // (register page: owner picked after the tap).
      const lb = d && d.lastBound;
      if (!boundBaselineSet) {
        lastBoundAt = lb ? lb.at : null;
        boundBaselineSet = true;
      } else if (lb && lb.at !== lastBoundAt) {
        lastBoundAt = lb.at;
        if (Date.now() > suppressBoundUntil) {
          log(`Bind confirmed by server: ${lb.cardId}`);
          await writeLine(`RFID BOUND|${String(lb.cardId).slice(0, 16)}`);
        }
      }
    }
  } catch (err) {
    warn(`device-status unreachable: ${err.message}`);
  } finally {
    pollTimer = setTimeout(pollStatus, nextDelay);
  }
}

// ---------------------------------------------------------------------------
// Start-up: self-test the API, then open serial
// ---------------------------------------------------------------------------
async function selfTest() {
  try {
    const r = await api('GET', '/rfid/ping');
    if (r.status === 200) {
      log(`API OK — server time ${r.json && r.json.serverTime}, backend mode: ${r.json && r.json.registrationMode ? 'BINDING' : 'ATTENDANCE'}`);
    } else if (r.status === 401 || r.status === 403) {
      warn('API reachable but the DEVICE KEY IS REJECTED. Fix RFID_DEVICE_KEY before tapping cards.');
    } else if (r.status === 404) {
      warn('API reachable but /rfid/ping is missing — the VPS is running an OLD backend build. Deploy the updated rfid files.');
    } else {
      warn(`API answered HTTP ${r.status} — Nginx/backend problem (502/504 = Node not reachable behind Nginx).`);
    }
  } catch (err) {
    warn(`API NOT REACHABLE at ${API_BASE}: ${err.message}`);
    warn(`Hint: ${networkHint(err.code)}`);
  }
}

(async () => {
  log(`RFID bridge v${BRIDGE_VERSION} — id=${BRIDGE_ID} — API ${API_BASE}`);
  await selfTest();
  try {
    await openSerial();
  } catch (e) {
    warn(e.message);
    scheduleReconnect('initial open failed');
  }
  pollStatus();
})();

process.on('SIGINT', () => {
  if (pollTimer) clearTimeout(pollTimer);
  if (port && port.isOpen) port.close(() => process.exit(0));
  else process.exit(0);
});