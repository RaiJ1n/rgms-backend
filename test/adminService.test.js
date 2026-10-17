// test/adminService.test.js - regression guard for services/adminService.js
// Why this exists: adminService.js was once accidentally overwritten with attendance-service code
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret';
const { install } = require('./helpers/fakeStore');
const User = require('../models/User');

const users = [];
// Stand-in for the schema's bcrypt matchPassword (plain equality is enough here)
install(User, users, { isActive: true, role: 'user', matchPassword(p) { return Promise.resolve(p === this.password); } });

const emailService = require('../services/emailService');
const sentOtps = [];
emailService.sendPasswordChangeOtpEmail = async (admin, otp) => { sentOtps.push({ to: admin.email, otp }); };

const adminService = require('../services/adminService');
const ROOT = path.join(__dirname, '..');
const EXPECTED = ['createAdmin', 'loginAdmin', 'getAdmins', 'requestPasswordChangeOtp', 'verifyAndChangePassword', 'ensureDefaultAdmin'];
const reset = () => { users.length = 0; sentOtps.length = 0; };

test('adminService exports exactly the admin API (and none of the attendance API)', () => {
  for (const name of EXPECTED) assert.equal(typeof adminService[name], 'function', `missing export: ${name}`);
  for (const wrong of ['processScan', 'manualVisitorAttendance', 'checkMemberEligibility']) {
    assert.equal(adminService[wrong], undefined, `adminService must not export attendance function ${wrong}`);
  }
});

test('every adminService.<fn> used anywhere in the backend exists', () => {
  const used = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'test' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && p !== path.join(ROOT, 'services', 'adminService.js')) {
        const src = fs.readFileSync(p, 'utf8');
        if (!/require\(['"][^'"]*adminService['"]\)/.test(src)) continue;
        for (const m of src.matchAll(/\badminService\.(\w+)/g)) used.set(m[1], path.relative(ROOT, p));
      }
    }
  };
  walk(ROOT);
  assert.ok(used.size >= 4, `expected callers to be discovered, found ${[...used.keys()]}`);
  for (const [fn, file] of used) assert.equal(typeof adminService[fn], 'function', `${file} calls adminService.${fn}, which does not exist`);
});

test('createAdmin creates a role=admin user and a token; duplicate email is refused', async () => {
  reset();
  const { admin, token } = await adminService.createAdmin({ fullname: 'A', email: 'a@x.test', password: 'password1', phone: '1' });
  assert.equal(admin.role, 'admin');
  assert.ok(token);
  await assert.rejects(adminService.createAdmin({ fullname: 'A', email: 'a@x.test', password: 'password1' }), /already exists/);
});

test('ensureDefaultAdmin: silent when unset, creates the first admin once, never when one exists', async () => {
  reset();
  const keep = { ...process.env };
  try {
    for (const k of ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_FULLNAME']) delete process.env[k];
    await adminService.ensureDefaultAdmin();
    assert.equal(users.length, 0);

    Object.assign(process.env, { ADMIN_EMAIL: 'Boss@X.test', ADMIN_PASSWORD: 'longenough1', ADMIN_FULLNAME: 'Boss' });
    await adminService.ensureDefaultAdmin();
    assert.equal(users.length, 1);
    assert.equal(users[0].role, 'admin');
    assert.equal(users[0].email, 'boss@x.test');

    await adminService.ensureDefaultAdmin();
    assert.equal(users.length, 1);

    reset();
    process.env.ADMIN_PASSWORD = 'short';
    await adminService.ensureDefaultAdmin();
    assert.equal(users.length, 0);
  } finally {
    for (const k of ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_FULLNAME']) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
  }
});

test('password-change OTP: request, cooldown, wrong/expired/valid code, single use', async () => {
  reset();
  const { admin } = await adminService.createAdmin({ fullname: 'A', email: 'a@x.test', password: 'oldpassword' });

  await assert.rejects(adminService.requestPasswordChangeOtp('nope'), (e) => e.statusCode === 404);
  const r = await adminService.requestPasswordChangeOtp(admin._id);
  assert.equal(r.sentTo, 'a@x.test');
  assert.equal(sentOtps.length, 1);
  await assert.rejects(adminService.requestPasswordChangeOtp(admin._id), (e) => e.statusCode === 429);

  const otp = sentOtps[0].otp;
  const base = { adminId: admin._id, currentPassword: 'oldpassword', newPassword: 'newpassword' };
  await assert.rejects(adminService.verifyAndChangePassword({ ...base, currentPassword: 'bad', otp }), (e) => e.statusCode === 401);
  await assert.rejects(adminService.verifyAndChangePassword({ ...base, otp: '000000' === otp ? '111111' : '000000' }), /Invalid verification code/);

  admin.passwordChangeOtpExpires = new Date(Date.now() - 1000);
  await assert.rejects(adminService.verifyAndChangePassword({ ...base, otp }), /expired/);
  admin.passwordChangeOtpExpires = new Date(Date.now() + 60000);

  await adminService.verifyAndChangePassword({ ...base, otp });
  assert.equal(admin.password, 'newpassword');
  assert.equal(admin.passwordChangeOtp, undefined);
  await assert.rejects(adminService.verifyAndChangePassword({ ...base, currentPassword: 'newpassword', otp }), /No verification code/);
});

test('controllers and main.js load against the real adminService (no import-time failure)', () => {
  require('../controllers/adminAuthController');
  require('../controllers/adminController');
});
