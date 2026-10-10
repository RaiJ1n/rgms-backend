// test/bridgeFlow.test.js - the REAL scripts/rfidBridge.js, run as a child
// process against a fake serial reader (test/helpers/mockSerial.js) and a stub
// HTTP API. Proves what the bridge does with reader timing: repeated signals,
// taps arriving while a request is in flight, retries, and silent duplicates.
// Real time (a few seconds in total); no hardware.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BRIDGE = path.join(__dirname, '..', 'scripts', 'rfidBridge.js');
const MOCK = path.join(__dirname, 'helpers', 'mockSerial.js');

// handler(req) -> { status, body, delayMs }   (called for POST /rfid/scan only)
async function runScenario({ script, handler, debounceMs = 300, extraEnv = {}, settleMs = 1500 }) {
  const posts = [];
  let inFlight = 0; let maxInFlight = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'POST' && req.url.endsWith('/rfid/scan')) {
        const body = JSON.parse(raw || '{}');
        const rec = { at: Date.now(), body, key: req.headers['x-device-key'] };
        posts.push(rec);
        inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
        const out = handler(rec, posts.length) || { status: 200, body: {} };
        if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
        inFlight -= 1;
        return json(out.status, out.body);
      }
      if (req.url.endsWith('/rfid/ping')) return json(200, { success: true, serverTime: new Date().toISOString() });
      return json(200, { success: true, data: { registrationMode: false, binding: {} } }); // device-status
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const child = spawn(process.execPath, ['-r', MOCK, BRIDGE], {
    env: {
      ...process.env,
      API_BASE: `http://127.0.0.1:${port}/api`,
      RFID_DEVICE_KEY: 'test-key',
      SERIAL_PORT: 'FAKE',
      RFID_DEBOUNCE_MS: String(debounceMs),
      FAKE_SERIAL_SCRIPT: JSON.stringify(script),
      ...extraEnv,
    },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const lastAt = Math.max(...script.map(([t]) => t));
  await new Promise((r) => setTimeout(r, lastAt + settleMs));
  child.kill('SIGKILL');
  await new Promise((r) => server.close(r));
  const writes = [...out.matchAll(/SERIAL_WRITE (.*)/g)].map((m) => m[1]);
  return { posts, writes, maxInFlight, log: out };
}

const ok = (action, name = 'Maria Santos') => ({
  status: 200,
  body: { success: true, action, lcd: { line1: action === 'checkin' ? 'WELCOME' : 'GOODBYE', line2: name } },
});

test('bridge: a card held on the reader (signal every 100 ms for 1 s) is ONE request', async () => {
  const script = Array.from({ length: 11 }, (_, i) => [i * 100, 'A1B2C3D4']);
  const r = await runScenario({ script, handler: () => ok('checkin') });
  assert.equal(r.posts.length, 1, 'one physical tap = one POST');
  assert.equal(r.posts[0].body.cardId, 'A1B2C3D4');
  assert.match(r.posts[0].body.scanId, /^[A-Za-z0-9_.:-]{8,90}$/);
  assert.equal(r.posts[0].key, 'test-key');
  assert.equal(r.writes.filter((w) => w.startsWith('WELCOME')).length, 1);
  assert.ok(!r.writes.some((w) => /PLEASE WAIT/.test(w)), 'repeats do not flash a warning over the confirmation');
});

test('bridge: held, lifted, tapped again = two requests with different scanIds', async () => {
  const held = Array.from({ length: 6 }, (_, i) => [i * 100, 'A1B2C3D4']); // 0..500
  const again = Array.from({ length: 4 }, (_, i) => [1100 + i * 100, 'A1B2C3D4']); // quiet 600 ms > 300
  let n = 0;
  const r = await runScenario({ script: [...held, ...again], handler: () => ok((n += 1) === 1 ? 'checkin' : 'checkout') });
  assert.equal(r.posts.length, 2);
  assert.notEqual(r.posts[0].body.scanId, r.posts[1].body.scanId);
  assert.deepEqual(r.writes.filter((w) => /^(WELCOME|GOODBYE)/.test(w)).map((w) => w.split('|')[0]), ['WELCOME', 'GOODBYE']);
});

test('bridge: four intentional taps arriving WHILE the server is slow are all sent, in order, one at a time', async () => {
  // taps every 400 ms, but the server takes 900 ms per request: the old bridge
  // dropped every tap that arrived mid-request ("PLEASE WAIT").
  const script = [0, 400, 800, 1200].map((t) => [t, 'A1B2C3D4']);
  const seq = ['checkin', 'checkout', 'checkin', 'checkout'];
  const r = await runScenario({
    script,
    debounceMs: 300,
    settleMs: 4500,
    handler: (_rec, n) => ({ ...ok(seq[n - 1]), delayMs: 900 }),
  });
  assert.equal(r.posts.length, 4, 'no tap lost');
  assert.equal(r.maxInFlight, 1, 'strictly sequential: tap N+1 is never sent before tap N is answered');
  assert.equal(new Set(r.posts.map((p) => p.body.scanId)).size, 4);
  assert.deepEqual(r.writes.filter((w) => /^(WELCOME|GOODBYE)/.test(w)).map((w) => w.split('|')[0]), ['WELCOME', 'GOODBYE', 'WELCOME', 'GOODBYE']);
  assert.ok(!r.writes.some((w) => /PLEASE WAIT/.test(w)));
});

test('bridge: a failed request is retried with the SAME scanId and shows the real result (not SERVER ERROR)', async () => {
  const r = await runScenario({
    script: [[0, 'A1B2C3D4']],
    handler: (_rec, n) => (n === 1 ? { status: 502, body: {} } : ok('checkin')),
    settleMs: 2500,
  });
  assert.equal(r.posts.length, 2);
  assert.equal(r.posts[0].body.scanId, r.posts[1].body.scanId, 'retry carries the same tap id');
  assert.ok(r.writes.some((w) => w.startsWith('WELCOME')));
  assert.ok(!r.writes.some((w) => /SERVER ERROR/.test(w)));
});

test('bridge: when every attempt fails the member sees a clear error, and the NEXT tap still works', async () => {
  const r = await runScenario({
    script: [[0, 'A1B2C3D4'], [2500, 'A1B2C3D4']],
    handler: (_rec, n) => (n <= 2 ? { status: 503, body: {} } : ok('checkin')),
    settleMs: 2500,
  });
  assert.ok(r.writes.some((w) => w.startsWith('SERVER ERROR|HTTP 503')));
  assert.ok(r.writes.some((w) => w.startsWith('WELCOME')), 'recovered on the next tap');
});

test('bridge: a duplicate the server marks silent leaves the LCD alone', async () => {
  const r = await runScenario({
    script: [[0, 'A1B2C3D4']],
    handler: () => ({ status: 429, body: { success: false, duplicate: true, silent: true, lcd: { line1: 'DUPLICATE', line2: 'SCAN IGNORED' } } }),
  });
  assert.equal(r.posts.length, 1);
  assert.ok(!r.writes.some((w) => /DUPLICATE/.test(w)));
});

test('bridge: a different card tapped right after is its own tap (debounce is per card)', async () => {
  const r = await runScenario({ script: [[0, 'A1B2C3D4'], [50, 'B1B2C3D4']], handler: () => ok('checkin') });
  assert.equal(r.posts.length, 2);
  assert.deepEqual(r.posts.map((p) => p.body.cardId).sort(), ['A1B2C3D4', 'B1B2C3D4']);
});

test('bridge: serial noise (boot banner, debug text) is never sent as a card', async () => {
  const r = await runScenario({ script: [[0, 'RFID Ready'], [100, 'A1B2C3D4']], handler: () => ok('checkin') });
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0].body.cardId, 'A1B2C3D4');
});
