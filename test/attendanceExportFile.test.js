// Regression: the attendance export must be a structurally valid .xlsx.
// (exceljs' streaming WorkbookWriter produced a zip whose workbook parts were
// all 0 bytes, so Excel reported the file as corrupt.) Runs the real
// controller over a real HTTP response with only the DB layer stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const ExcelJS = require('exceljs');
const Attendance = require('../models/Attendance');
const attendanceQuery = require('../services/attendanceQueryService');
const history = require('../services/attendanceHistoryService');
const ctrl = require('../controllers/rfidController');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const at = (h) => new Date(`2026-10-15T${String(h).padStart(2, '0')}:00:00+08:00`);
const mk = (id, n, inH, outH) => ({
  _id: id, userId: { _id: 'm1', fullname: 'Ana Reyes' }, status: outH ? 'Completed' : 'Present',
  checkIn: at(inH), checkOut: outH ? at(outH) : null,
  createdAt: at(inH), sessionNo: n, sessionsThatDay: 2, rfidCardId: { cardType: 'PERMANENT' },
});

function stub(docs) {
  const orig = { cnt: Attendance.countDocuments, find: Attendance.find, build: attendanceQuery.buildLogFilter, dec: history.decorate };
  attendanceQuery.buildLogFilter = async () => ({ ok: true, filter: {} });
  history.decorate = async (rows) => rows;
  Attendance.countDocuments = async () => docs.length;
  Attendance.find = () => {
    const c = { populate: () => c, sort: () => c, lean: () => c, cursor: () => (async function* () { yield* docs; })() };
    return c;
  };
  return () => { Attendance.countDocuments = orig.cnt; Attendance.find = orig.find; attendanceQuery.buildLogFilter = orig.build; history.decorate = orig.dec; };
}

async function call(query = {}) {
  const server = http.createServer((req, res) => {
    // Minimal Express-style helpers for the plain Node response.
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    return ctrl.exportLogs({ query }, res, (e) => { res.statusCode = 500; res.end(JSON.stringify({ success: false, message: e.message })); });
  });
  await new Promise((r) => server.listen(0, r));
  const out = await new Promise((resolve) => http.get({ port: server.address().port }, (r) => {
    const parts = []; r.on('data', (d) => parts.push(d)); r.on('end', () => resolve({ r, body: Buffer.concat(parts) }));
  }));
  server.close();
  return out;
}

test('export is a valid workbook: zip signature, headers, one row per session', async () => {
  const restore = stub([mk('s1', 1, 8, 9), mk('s2', 2, 10, null)]);
  try {
    const { r, body } = await call({ startDate: '2026-10-15', endDate: '2026-10-15' });
    assert.equal(r.statusCode, 200, body.toString());
    assert.equal(r.headers['content-type'], XLSX_MIME);
    assert.match(r.headers['content-disposition'], /REMER_Attendance_2026-10-15\.xlsx/);
    assert.equal(Number(r.headers['content-length']), body.length);
    assert.equal(body.subarray(0, 2).toString(), 'PK');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body);                       // throws if any workbook part is empty/invalid
    const ws = wb.getWorksheet('Attendance');
    assert.equal(ws.getRow(1).getCell(3).value, 'Name');
    assert.equal(ws.rowCount, 3);                   // header + 2 sessions for the SAME member
    assert.equal(ws.getRow(2).getCell(2).value, ws.getRow(3).getCell(2).value);
    assert.notEqual(ws.getRow(2).getCell(1).value, ws.getRow(3).getCell(1).value);
    assert.ok(!ws.getRow(3).getCell(6).value);      // open session: Time Out stays blank
  } finally { restore(); }
});

test('empty result set returns a JSON 404, never an .xlsx', async () => {
  const restore = stub([]);
  try {
    const { r, body } = await call();
    assert.equal(r.statusCode, 404);
    assert.ok(!String(r.headers['content-disposition'] || '').includes('.xlsx'));
    assert.equal(JSON.parse(body.toString()).success, false);
  } finally { restore(); }
});

test('a failure while building is a JSON error, not a partial .xlsx', async () => {
  const restore = stub([mk('s1', 1, 8, 9)]);
  history.decorate = async () => { throw new Error('boom'); };
  try {
    const { r, body } = await call();
    assert.equal(r.statusCode, 500);
    assert.ok(!r.headers['content-disposition']);
    assert.equal(JSON.parse(body.toString()).message, 'boom');
  } finally { restore(); }
});
