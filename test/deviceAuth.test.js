// run with: node --test test/deviceAuth.test.js  (no database needed)
const test = require('node:test');
const assert = require('node:assert/strict');
const { requireDeviceKey } = require('../middleware/deviceAuthMiddleware');

const KEY = 'test-device-key-0123456789';

function run(headers, ...rest) {
  const envKey = rest.length ? rest[0] : KEY;
  if (envKey === undefined) delete process.env.RFID_DEVICE_KEY;
  else process.env.RFID_DEVICE_KEY = envKey;
  const out = { nextCalled: false, status: 200, body: null };
  const res = {
    status(c) { out.status = c; return this; },
    json(b) { out.body = b; return this; },
  };
  requireDeviceKey({ headers }, res, () => { out.nextCalled = true; });
  return out;
}

test('valid key passes', () => {
  assert.equal(run({ 'x-device-key': KEY }).nextCalled, true);
});

test('valid key with surrounding whitespace/newline (header or env) passes', () => {
  assert.equal(run({ 'x-device-key': ` ${KEY}\r\n` }).nextCalled, true);
  assert.equal(run({ 'x-device-key': KEY }, `${KEY}\n`).nextCalled, true);
});

test('wrong key is rejected with 401 + device_key_invalid', () => {
  const r = run({ 'x-device-key': 'wrong-key' });
  assert.equal(r.nextCalled, false);
  assert.equal(r.status, 401);
  assert.equal(r.body.errorCode, 'device_key_invalid');
  assert.equal(r.body.success, false);
});

test('different-length and prefix keys are rejected', () => {
  assert.equal(run({ 'x-device-key': KEY.slice(0, -1) }).status, 401);
  assert.equal(run({ 'x-device-key': `${KEY}x` }).status, 401);
});

test('missing or blank key is rejected with 401 + device_key_missing', () => {
  for (const h of [{}, { 'x-device-key': '' }, { 'x-device-key': '   ' }]) {
    const r = run(h);
    assert.equal(r.nextCalled, false);
    assert.equal(r.status, 401);
    assert.equal(r.body.errorCode, 'device_key_missing');
  }
});

test('server without RFID_DEVICE_KEY fails closed (500), never lets a request through', () => {
  for (const env of [undefined, '', '   ']) {
    const r = run({ 'x-device-key': 'anything' }, env);
    assert.equal(r.nextCalled, false);
    assert.equal(r.status, 500);
    assert.equal(r.body.errorCode, 'device_key_not_configured');
  }
});

test('response never contains the configured key', () => {
  const r = run({ 'x-device-key': 'nope' });
  assert.ok(!JSON.stringify(r.body).includes(KEY));
});
