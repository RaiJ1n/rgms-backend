// scripts/rfidDiagnose.js
//
// Finds the exact break in:
//   RFID card -> RC522 -> Arduino -> USB serial -> PC -> DNS -> TLS -> Nginx
//   -> Express -> device key -> backend mode
//
// Run on the PC the Arduino is plugged into (stop rfidBridge.js first — two
// programs cannot open the same COM port):
//
//   node scripts/rfidDiagnose.js               # full check, 20s card capture
//   node scripts/rfidDiagnose.js --listen 40   # capture window in seconds
//   node scripts/rfidDiagnose.js --no-serial   # API checks only (no Arduino)
//
// It never prints the device key, and it never POSTs a card scan.

const path = require('path');
const dns = require('dns').promises;
try {
  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, 'bridge.env') });
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
} catch {
  /* optional */
}

const API_BASE = (process.env.API_BASE || 'https://api.remerfitnessgym.tech/api').replace(/\/$/, '');
const DEVICE_KEY = process.env.RFID_DEVICE_KEY || '';
const BAUD = Number(process.env.BAUD || 9600);
const args = process.argv.slice(2);
const listenIdx = args.indexOf('--listen');
const LISTEN_S = listenIdx >= 0 ? Number(args[listenIdx + 1]) || 20 : 20;
const SKIP_SERIAL = args.includes('--no-serial');

const results = [];
const mark = (ok, name, detail = '') => {
  results.push({ ok, name });
  console.log(`${ok === true ? '✅' : ok === false ? '❌' : '⚠️ '} ${name}${detail ? ` — ${detail}` : ''}`);
};
const head = (t) => console.log(`\n=== ${t} ===`);

async function timedFetch(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const start = Date.now();
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { res, text, json, ms: Date.now() - start };
  } finally {
    clearTimeout(t);
  }
}

async function checkEnvironment() {
  head('1. Environment');
  const major = Number(process.versions.node.split('.')[0]);
  mark(major >= 18, `Node ${process.version}`, major >= 18 ? '' : 'Node 18+ required (global fetch). On older Node the bridge printed SERVER ERROR for every tap.');
  mark(!!DEVICE_KEY, 'RFID_DEVICE_KEY set', DEVICE_KEY ? `${DEVICE_KEY.length} characters` : 'NOT SET — export it or put it in scripts/bridge.env');
  console.log(`   API_BASE = ${API_BASE}`);
  if (/localhost|127\.0\.0\.1/.test(API_BASE)) {
    mark(null, 'API_BASE points at localhost', 'If the admin site uses the VPS, the bridge and the site are talking to DIFFERENT backends (binding mode set on one, taps sent to the other).');
  }
}

async function checkSerial() {
  head('2. Arduino → USB serial (does the reader produce a UID at all?)');
  let SerialPort, ReadlineParser, normalizeUid, isValidUid;
  try {
    ({ SerialPort } = require('serialport'));
    ({ ReadlineParser } = require('@serialport/parser-readline'));
    ({ normalizeUid, isValidUid } = require('../utils/normalizeUid'));
  } catch (e) {
    return mark(false, 'serialport module', e.message);
  }
  const ports = await SerialPort.list();
  if (!ports.length) {
    return mark(false, 'No serial ports found', 'Arduino not detected by the OS: cable (data cable, not charge-only), USB port, driver (CH340/CP210x).');
  }
  ports.forEach((p) => console.log(`   port: ${p.path}  vendor=${p.vendorId || '?'} product=${p.productId || '?'} ${p.manufacturer || ''}`));
  const pick = process.env.SERIAL_PORT || (ports.find((p) => p.vendorId) || ports[0]).path;
  console.log(`   using ${pick} @ ${BAUD}  (set SERIAL_PORT to change)`);

  await new Promise((resolve) => {
    const sp = new SerialPort({ path: pick, baudRate: BAUD, autoOpen: false });
    sp.open((err) => {
      if (err) {
        mark(false, `Open ${pick}`, `${err.message} — another program has the port (Arduino IDE Serial Monitor, rfidBridge.js, or a LOCAL backend).`);
        return resolve();
      }
      mark(true, `Open ${pick}`);
      console.log(`\n   >>> TAP A CARD NOW (listening ${LISTEN_S}s). Every line the Arduino sends is shown below. <<<\n`);
      const lines = [];
      const parser = sp.pipe(new ReadlineParser({ delimiter: '\n' }));
      parser.on('data', (l) => {
        const raw = String(l).replace(/\r/g, '');
        const uid = normalizeUid(raw);
        const valid = isValidUid(uid);
        lines.push({ raw, valid });
        console.log(`   RX ${JSON.stringify(raw)}  =>  normalized "${uid}"  ${valid ? '(valid UID ✅)' : '(not a UID)'}`);
      });
      setTimeout(() => {
        sp.close(() => {
          const uids = lines.filter((x) => x.valid);
          if (uids.length) {
            mark(true, 'Arduino sends a valid UID over serial', `${uids.length} tap(s) seen. Reader/wiring/sketch are fine — the fault is downstream.`);
          } else if (lines.length) {
            mark(false, 'Arduino talks, but never sent a valid UID', 'Wrong baud, sketch prints extra text instead of the bare UID, or the card was not read. Compare Serial.begin() with BAUD.');
          } else {
            mark(false, 'Arduino sent NOTHING', 'STOP backend debugging. Fix hardware first: RC522 wiring (SDA→10, SCK→13, MOSI→11, MISO→12, RST→9, 3.3V — NOT 5V, GND), MFRC522 library, sketch uploaded, baud rate.');
          }
          resolve();
        });
      }, LISTEN_S * 1000);
    });
  });
}

async function checkApi() {
  head('3. PC → VPS → Nginx → Express');
  let host;
  try { host = new URL(API_BASE).hostname; } catch { return mark(false, 'API_BASE is not a valid URL', API_BASE); }
  try {
    const a = await dns.lookup(host);
    mark(true, `DNS ${host}`, a.address);
  } catch (e) {
    return mark(false, `DNS ${host}`, `${e.code} — domain does not resolve from this PC.`);
  }

  try {
    const r = await timedFetch(`${API_BASE}/rfid/ping`, { headers: { 'x-device-key': DEVICE_KEY } });
    const s = r.res.status;
    if (s === 200) {
      mark(true, `GET /rfid/ping → 200 (${r.ms}ms)`, `backend mode: ${r.json && r.json.registrationMode ? 'BINDING' : 'ATTENDANCE'}`);
    } else if (s === 401) {
      mark(false, 'GET /rfid/ping → 401', 'Backend is up and reachable, but RFID_DEVICE_KEY here ≠ VPS .env value.');
    } else if (s === 404) {
      mark(false, 'GET /rfid/ping → 404', 'Either the VPS runs an OLD backend (no /ping yet) or Nginx routes /api elsewhere. Try /api/rfid/device-status.');
    } else if (s === 500) {
      mark(false, 'GET /rfid/ping → 500', `${(r.json && r.json.message) || 'backend error'} — if "RFID_DEVICE_KEY is not set": add it to the VPS .env and restart PM2.`);
    } else if (s === 502 || s === 503) {
      mark(false, `GET /rfid/ping → ${s}`, 'Nginx is up but the Node app is NOT reachable behind it (pm2 stopped/crashed, or wrong proxy_pass port).');
    } else if (s === 504) {
      mark(false, 'GET /rfid/ping → 504', 'Nginx timed out waiting for Node (backend hung, DB down, or proxy_read_timeout too low).');
    } else {
      mark(false, `GET /rfid/ping → ${s}`, r.text.slice(0, 120).replace(/\s+/g, ' '));
    }
  } catch (e) {
    const cause = e.cause || e;
    const code = e.name === 'AbortError' ? 'TIMEOUT' : (typeof cause.code === 'string' && cause.code) || e.name;
    mark(false, 'GET /rfid/ping — no HTTP response at all', `${code}: ${cause.message || ''} — this is exactly what shows on the LCD as SERVER ERROR / NO RESPONSE.`);
  }

  try {
    const r = await timedFetch(`${API_BASE}/rfid/device-status`, { headers: { 'x-device-key': DEVICE_KEY } });
    mark(r.res.status === 200, `GET /rfid/device-status → ${r.res.status}`, r.res.status === 200 ? 'heartbeat endpoint OK (admin UI will show scanner online while the bridge runs)' : '');
  } catch (e) {
    mark(false, 'GET /rfid/device-status', e.message);
  }
}

(async () => {
  console.log(`RFID chain diagnostic — ${new Date().toISOString()}`);
  await checkEnvironment();
  if (!SKIP_SERIAL) await checkSerial();
  await checkApi();
  head('Summary');
  const bad = results.filter((r) => r.ok === false);
  if (!bad.length) console.log('All checks passed. Start the bridge: node scripts/rfidBridge.js');
  else {
    console.log('First failing step (fix this one first — later ones are usually consequences):');
    console.log(`   ❌ ${bad[0].name}`);
  }
  process.exit(bad.length ? 1 : 0);
})();