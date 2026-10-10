// Preload (node -r) used by test/bridgeFlow.test.js. Replaces the `serialport`
// packages with an in-memory reader so the REAL scripts/rfidBridge.js can be run
// with scripted reader timing and no hardware.
//
//   FAKE_SERIAL_SCRIPT = JSON [[atMs, "LINE"], ...]   lines the "Arduino" prints,
//                        atMs measured from the moment the port opens
// Everything the bridge writes back to the LCD is echoed to stdout as
//   SERIAL_WRITE <text>
const Module = require('module');
const { EventEmitter } = require('events');

class FakeParser extends EventEmitter {}
class FakeSerialPort extends EventEmitter {
  constructor(opts) { super(); this.path = opts.path; this.isOpen = false; }
  static async list() { return [{ path: 'FAKE', vendorId: '2341', productId: '0043' }]; }
  open(cb) {
    this.isOpen = true;
    setImmediate(() => {
      cb(null);
      const script = JSON.parse(process.env.FAKE_SERIAL_SCRIPT || '[]');
      for (const [at, line] of script) setTimeout(() => this.parser && this.parser.emit('data', line), at);
    });
  }
  pipe(parser) { this.parser = parser; return parser; }
  write(data, cb) { console.log(`SERIAL_WRITE ${String(data).trim()}`); if (cb) cb(null); return true; }
  close(cb) { this.isOpen = false; if (cb) cb(); }
}

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'serialport') return { SerialPort: FakeSerialPort };
  if (request === '@serialport/parser-readline') return { ReadlineParser: FakeParser };
  return realLoad.call(this, request, ...rest);
};
