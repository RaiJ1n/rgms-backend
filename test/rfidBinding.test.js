// run with: node --test test/rfidBinding.test.js  (no database needed)
// Model statics are stubbed in memory; this verifies the decision logic, not real
// MongoDB semantics (the unique-index race is simulated with an E11000 error).
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
delete process.env.RFID_HASH_SECRET;

const RFIDCard = require('../models/RFIDCard');
const User = require('../models/User');
const Coach = require('../models/Coach');
const AuditLog = require('../models/AuditLog');
const TempCardAssignment = require('../models/TempCardAssignment');
const ctrl = require('../controllers/rfidController');

const UID = '419A4E16';
const M1 = 'a'.repeat(24), M2 = 'b'.repeat(24), GONE = 'c'.repeat(24);
let cards, users, audits, failNextSave;
let loans = {};

function mkCard(o) {
  const c = { _id: 'card' + cards.length, active: true, ...o };
  c.save = async () => { if (!cards.includes(c)) cards.push(c); return c; };
  c.deleteOne = async () => {};
  return c;
}
const origNew = Object.getOwnPropertyDescriptor(RFIDCard.prototype, 'save');
function setup(seed = []) {
  cards = []; users = new Set([M1, M2]); audits = []; failNextSave = null; loans = {};
  seed.forEach((s) => cards.push(mkCard(s)));
  RFIDCard.findOne = (q) => {
    const wanted = q.cardId || (q.$or && q.$or.find((x) => x.cardId)?.cardId);
    return Promise.resolve(cards.find((c) => c.cardId === wanted) || null);
  };
  RFIDCard.prototype.save = async function () {
    if (failNextSave) { const e = failNextSave; failNextSave = null; throw e; }
    if (cards.some((c) => c.cardId === this.cardId)) { const e = new Error('dup'); e.code = 11000; throw e; }
    cards.push(this); return this;
  };
  User.exists = async ({ _id }) => (users.has(String(_id)) ? { _id } : null);
  Coach.exists = async () => null;
  User.findById = async (id) => (users.has(String(id)) ? { fullname: 'Test Member' } : null);
  Coach.findById = async () => null;
  AuditLog.create = async (d) => { audits.push(d); return d; };
  TempCardAssignment.findById = async (id) => loans[String(id)] || null;
}
const call = async (body, user = { _id: 'admin1' }) => {
  const out = { status: 200, body: null, err: null };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  await ctrl.registerCard({ body, user }, res, (e) => { out.err = e; });
  return out;
};

test('valid bind creates the card and audits it', async () => {
  setup();
  const r = await call({ userId: M1, cardId: '41 9a 4e 16' });
  assert.equal(r.status, 201);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].cardId, UID);
  assert.equal(audits.length, 1);
});

test('card genuinely assigned to ANOTHER existing member -> 409, never overwritten', async () => {
  setup([{ cardId: UID, userId: M2 }]);
  const r = await call({ userId: M1, cardId: UID });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /another account/);
  assert.equal(String(cards[0].userId), M2);
});

test('same member again -> idempotent 200, no duplicate card', async () => {
  setup([{ cardId: UID, userId: M1 }]);
  const r = await call({ userId: M1, cardId: UID });
  assert.equal(r.status, 200);
  assert.equal(r.body.alreadyBound, true);
  assert.equal(cards.length, 1);
});

test('ORPHAN card (owner deleted) is reclaimed instead of a false duplicate error', async () => {
  setup([{ cardId: UID, userId: GONE }]);
  const r = await call({ userId: M1, cardId: UID });
  assert.equal(r.status, 201);
  assert.equal(cards.length, 1);
  assert.equal(String(cards[0].userId), M1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].meta.reclaimedFromMissingOwner, GONE);
});

test('card with no owner at all is reclaimable', async () => {
  setup([{ cardId: UID }]);
  assert.equal((await call({ userId: M1, cardId: UID })).status, 201);
});

const FUTURE = new Date(Date.now() + 6 * 3600e3), PAST = new Date(Date.now() - 6 * 3600e3);

test('temporary card still IN USE is not bound: lent to a member, or visitor pass still valid', async () => {
  setup([{ cardId: UID, cardType: 'TEMPORARY', memberAssignmentId: 'loan1' }]);
  loans.loan1 = { status: 'ACTIVE' };
  let r = await call({ userId: M1, cardId: UID });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /currently in use/i);
  setup([{ cardId: UID, cardType: 'TEMPORARY', visitorName: 'Guest', validFrom: PAST, validUntil: FUTURE }]);
  r = await call({ userId: M1, cardId: UID });
  assert.equal(r.status, 409);
  assert.equal(cards[0].cardType, 'TEMPORARY');
});

test('Coach model is an empty stub (as in production): binding still works, no 500', async () => {
  setup([{ cardId: UID, cardType: 'MEMBER', userId: M2 }]);
  const saved = Coach.exists;
  delete Coach.exists; // models/Coach.js is `module.exports = {}`
  try {
    const other = await call({ userId: M1, cardId: UID });
    assert.equal(other.status, 409, 'real owner still blocks');
    assert.equal(other.err, null);
    setup([{ cardId: UID, cardType: 'MEMBER', userId: GONE }]);
    delete Coach.exists;
    const orphan = await call({ userId: M1, cardId: UID });
    assert.equal(orphan.status, 201, 'orphan is reclaimed');
  } finally {
    Coach.exists = saved;
  }
});

test('STALE loan pointer (loan already RETURNED) does not block binding; card converts', async () => {
  setup([{ cardId: UID, cardType: 'TEMPORARY', memberAssignmentId: 'loan1' }]);
  loans.loan1 = { status: 'RETURNED' };
  const r = await call({ userId: M1, cardId: UID });
  assert.equal(r.status, 201);
  assert.equal(cards[0].cardType, 'MEMBER');
  assert.equal(cards[0].memberAssignmentId, undefined);
});

test('RETURNED temporary card (spare, nobody holds it) converts to a member card', async () => {
  setup([{ cardId: UID, cardType: 'TEMPORARY' }]); // what releaseCard leaves behind
  const r = await call({ userId: M1, cardId: UID });
  assert.equal(r.status, 201);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].cardType, 'MEMBER');
  assert.equal(String(cards[0].userId), M1);
  assert.equal(audits[0].meta.convertedFromTemporaryCard, true);
});

test('checked-out / expired / revoked visitor pass converts and loses every visitor field', async () => {
  const base = { cardId: UID, cardType: 'TEMPORARY', visitorName: 'Guest', validFrom: PAST, memberAssignmentId: undefined };
  for (const extra of [
    { validUntil: FUTURE, checkedInAt: PAST, checkedOutAt: new Date() },
    { validUntil: PAST },
    { validUntil: FUTURE, active: false },
  ]) {
    setup([{ ...base, ...extra }]);
    const r = await call({ userId: M1, cardId: UID });
    assert.equal(r.status, 201, JSON.stringify(extra));
    const c = cards[0];
    assert.equal(c.cardType, 'MEMBER');
    assert.equal(c.active, true);
    for (const f of ['visitorName', 'validFrom', 'validUntil', 'checkedInAt', 'checkedOutAt', 'memberAssignmentId']) assert.equal(c[f], undefined, f);
  }
});

test('race with bridge auto-bind (E11000) for the SAME member converges to success', async () => {
  setup();
  RFIDCard.findOne = (() => { let n = 0; return () => Promise.resolve(n++ === 0 ? null : cards[0]); })();
  cards.push(mkCard({ cardId: UID, userId: M1 }));
  const r = await call({ userId: M1, cardId: UID });
  assert.equal(r.status, 200);
  assert.equal(r.body.alreadyBound, true);
});

test('race lost to a DIFFERENT member -> 409, not the misleading "reference number" error', async () => {
  setup();
  RFIDCard.findOne = (() => { let n = 0; return () => Promise.resolve(n++ === 0 ? null : cards[0]); })();
  cards.push(mkCard({ cardId: UID, userId: M2 }));
  const r = await call({ userId: M1, cardId: UID });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /another account/);
});

test('invalid member -> 404 and nothing is written', async () => {
  setup();
  const r = await call({ userId: GONE, cardId: UID });
  assert.equal(r.status, 404);
  assert.equal(cards.length, 0);
});

test('invalid UID format -> 400; missing owner -> 400', async () => {
  setup();
  assert.equal((await call({ userId: M1, cardId: 'ZZZ' })).status, 400);
  assert.equal((await call({ cardId: UID })).status, 400);
});

test('database write failure is passed to the error handler, no success response', async () => {
  setup();
  failNextSave = new Error('db down');
  const r = await call({ userId: M1, cardId: UID });
  assert.equal(r.err.message, 'db down');
  assert.equal(r.body, null);
  assert.equal(cards.length, 0);
});

test('unauthorized: POST /api/rfid/register without an admin token is rejected before the controller', async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-route-check';
  const http = require('http');
  const app = require('../app');
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/rfid/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: M1, cardId: UID }),
    });
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
    // and a device key alone must NOT unlock the admin route
    const res2 = await fetch(`http://127.0.0.1:${port}/api/rfid/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-key': 'whatever' },
      body: JSON.stringify({ userId: M1, cardId: UID }),
    });
    assert.ok(res2.status === 401 || res2.status === 403, `got ${res2.status}`);
  } finally {
    server.close();
  }
});

test('unbind removes an orphaned card (no owner) and audits it; unknown card -> 404', async () => {
  setup([{ cardId: UID, userId: GONE }]);
  let deleted = false;
  cards[0].deleteOne = async () => { deleted = true; };
  RFIDCard.findOne = async (q) => cards.find((c) => c.cardId === (q.cardId || q.$or?.find((x) => x.cardId)?.cardId)) || null;
  const run = async (cardId) => {
    const out = { status: 200, body: null };
    const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
    await ctrl.unbindCard({ params: { cardId }, user: { _id: 'admin1' } }, res, (e) => { throw e; });
    return out;
  };
  const ok = await run(UID);
  assert.equal(ok.status, 200);
  assert.equal(deleted, true);
  assert.equal(audits.at(-1).action, 'rfid_unbind');
  assert.equal((await run('AAAAAAAA')).status, 404);
});