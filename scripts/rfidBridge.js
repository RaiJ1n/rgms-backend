// scripts/rfidBridge.js
//
// Local serial ↔ API bridge for split deployments.
//
// PROBLEM: the Arduino talks USB-serial to ONE machine, but the frontend
// (VITE_API_URL=https://api.remerfitnessgym.tech/api) talks to a VPS that
// has no USB ports. Setting registration-mode on the VPS then tapping a
// card on the local Arduino can never meet: the local backend (if running)
// stays in attendance mode → "RFID NOT REGISTERED", or nothing answers →
// the sketch's no-response fallback.
//
// This bridge runs on the PC the Arduino is plugged into. It:
//   1. Reads raw UID lines from the Arduino over serial.
//   2. POSTs each UID to POST <API_BASE>/rfid/scan with x-device-key.
//      The backend routes binding vs attendance (registration-mode) and
//      returns `lcd: { line1, line2 }` in every response — the bridge just
//      writes those lines back to the Arduino as "line1|line2".
//   3. Relays MODE:ATTENDANCE / MODE:REGISTER / MODE:BIND idle commands by
//      polling GET <API_BASE>/rfid/status (same backend the frontend
//      toggles), so the LCD idle screen tracks binding mode on the VPS.
//
// Run:  node scripts/rfidBridge.js
// Env:  API_BASE (default https://api.remerfitnessgym.tech/api)
//       RFID_DEVICE_KEY (required — same value as backend .env)
//       SERIAL_PORT (optional — auto-detects Arduino/CH340/CP210x/FTDI)
//       BAUD (default 9600)

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

const API_BASE = (process.env.API_BASE || 'https://api.remerfitnessgym.tech/api').replace(/\/$/, '');
const DEVICE_KEY = process.env.RFID_DEVICE_KEY || '';
const BAUD = Number(process.env.BAUD || 9600);
const PREFERRED_PORT = process.env.SERIAL_PORT || null;
const STATUS_POLL_MS = 3000;

if (!DEVICE_KEY) {
  console.error('[BRIDGE] Missing RFID_DEVICE_KEY env. Set it to the same value as the backend .env.');
  process.exit(1);
}

const headers = { 'Content-Type': 'application/json', 'x-device-key': DEVICE_KEY };
let port = null;
let parser = null;
let lastMode = null;
let busy = false;

function normalizeUid(raw) {
  return String(raw == null ? '' : raw).trim().replace(/[\s\-:]/g, '').toUpperCase();
}

async function pickPort() {
  const ports = await SerialPort.list();
  if (PREFERRED_PORT) {
    const found = ports.find((p) => p.path === PREFERRED_PORT);
    if (!found) throw new Error(`SERIAL_PORT ${PREFERRED_PORT} not found. Available: ${ports.map((p) => p.path).join(', ') || '(none)'}`);
    return found.path;
  }
  const KNOWN = new Set(['2341:0043', '2341:0001', '2341:0010', '2341:0042', '2341:0037', '2341:0036', '2A03:0043', '1A86:7523', '1A86:5523', '10C4:EA60', '0403:6001', '0403:6015']);
  const match = ports.find((p) => p.vendorId && p.productId && KNOWN.has(`${String(p.vendorId).toUpperCase()}:${String(p.productId).toUpperCase()}`));
  if (match) return match.path;
  if (ports.length === 1) return ports[0].path;
  throw new Error(`No Arduino auto-detected. Available: ${ports.map((p) => p.path).join(', ') || '(none)'}. Set SERIAL_PORT explicitly.`);
}

function writeLine(text) {
  return new Promise((resolve) => {
    if (!port || !port.isOpen) return resolve(false);
    port.write(`${text}\n`, (err) => {
      if (err) console.warn('[BRIDGE] Serial write failed:', err.message);
      resolve(!err);
    });
  });
}

async function handleUid(rawLine) {
  const raw = String(rawLine || '').trim();
  const uid = normalizeUid(rawLine);
  if (!uid) return;
  if (busy) {
    console.log(`[BRIDGE] Tap ${uid} ignored — previous tap still in flight`);
    return;
  }
  busy = true;
  try {
    console.log(`[BRIDGE] UID ${raw} → ${uid} → POST ${API_BASE}/rfid/scan`);
    const res = await fetch(`${API_BASE}/rfid/scan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cardId: uid }),
    });
    const body = await res.json().catch(() => ({}));
    // ============ RFID DEBUG ============
    console.log(`[BRIDGE] HTTP ${res.status} bindingMode=${body.bindingMode === true}`);
    // ====================================
    const lcd = body.lcd;
    if (lcd && lcd.line1) {
      await writeLine(`${lcd.line1}|${lcd.line2 || ''}`);
      // Two-stage check-in display (mirrors rfidService LCD_STAGE_DELAY_MS).
      if (lcd.stage2 && lcd.stage2.lcdLine1) {
        setTimeout(() => writeLine(`${lcd.stage2.lcdLine1}|${lcd.stage2.lcdLine2 || ''}`), 2000);
      }
    } else if (body.bindingMode) {
      await writeLine(`Card detected|${uid.slice(0, 16)}`);
    } else if (body.message) {
      await writeLine(`${String(body.message).slice(0, 16)}|`);
    }
    if (body.bindingMode) console.log(`[BRIDGE] Binding tap captured: ${uid} (complete it in the admin UI)`);
  } catch (err) {
    console.warn('[BRIDGE] API unreachable:', err.message);
    // Backend offline must NOT look like an unknown card (Test 9).
    await writeLine('SERVER ERROR|NO RESPONSE');
  } finally {
    busy = false;
  }
}

async function pollStatus() {
  try {
    const res = await fetch(`${API_BASE}/rfid/status`, { headers });
    if (!res.ok) return;
    const body = await res.json().catch(() => null);
    const b = body && body.data && body.data.binding ? body.data.binding : body && body.data;
    const mode = !(b && (b.registrationMode || (b.binding && b.binding.enabled) || b.enabled))
      ? 'ATTENDANCE'
      : ((b.binding && b.binding.mode) === 'bind' || b.mode === 'bind' ? 'BIND' : 'REGISTER');
    if (mode !== lastMode) {
      lastMode = mode;
      console.log(`[BRIDGE] Mode → ${mode}`);
      await writeLine(`MODE:${mode}`);
    }
  } catch {
    // Poll failures are silent; per-tap errors already report NO RESPONSE.
  }
}

(async () => {
  const path = await pickPort().catch((e) => {
    console.error(`[BRIDGE] ${e.message}`);
    process.exit(1);
  });
  console.log(`[BRIDGE] Opening ${path} @ ${BAUD} → ${API_BASE}`);
  port = new SerialPort({ path, baudRate: BAUD, autoOpen: false });
  port.open((err) => {
    if (err) {
      console.error(`[BRIDGE] Could not open ${path}: ${err.message}`);
      process.exit(1);
    }
    console.log('[BRIDGE] Serial open. Tap a card.');
    parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', handleUid);
    port.on('error', (e) => console.error('[BRIDGE] Serial error:', e.message));
    port.on('close', () => {
      console.error('[BRIDGE] Serial closed. Restart the bridge after reconnecting the Arduino.');
      process.exit(1);
    });
    pollStatus();
    setInterval(pollStatus, STATUS_POLL_MS);
  });
})();
