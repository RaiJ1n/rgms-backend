// Preload (node -r) used by test/bridgeFlow.test.js
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
