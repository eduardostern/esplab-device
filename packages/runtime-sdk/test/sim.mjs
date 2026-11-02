// A simulated ESP32 for "lab"/"io" programs: the firmware's host functions, a virtual clock,
// and simulated hardware (Modbus slave, DS18B20 bus, SX127x radio).
import crypto from 'node:crypto';

export class Device {
  constructor({ id = 'esp32-aabbccddeeff', script = [], hardware = {}, kv = new Map() } = {}) {
    this.id = id;
    this.kv = kv; // NVS: survives a "restart" when passed to the next Device
    this.now = 0;
    this.script = script; // functions called on each waitEvent; return an event or null; end => stop
    this.sent = []; // frames from send() (cloud link)
    this.log = '';
    this.hw = hardware;
    this.pins = {};
  }
  mem() { return new Uint8Array(this.memory.buffer); }
  /** The 1-Wire bus on a pin: hardware.ow (one bus on every pin) or hardware.owPins[pin]. */
  bus(pin) { return this.hw.owPins ? this.hw.owPins[pin] : this.hw.ow; }
  str16(ptr, bytes) { return Buffer.from(this.mem().slice(ptr, ptr + bytes)).toString('utf16le'); }
  imports() {
    const d = this;
    const esp = {
      waitEvent(timeout, buf, cap) {
        const step = d.script.shift();
        if (!step) return -1;
        const ev = step(d);
        // A program that never waits would spin the CPU on a real board: fail the test.
        d.zeroWaits = timeout <= 0 && !ev ? (d.zeroWaits ?? 0) + 1 : 0;
        if (d.zeroWaits > 5000) throw new Error(`busy loop: the program stopped waiting at ${d.now} ms`);
        if (!ev) { d.now += Math.max(timeout, 0); return 0; }
        d.now += 5;
        const data = ev.data;
        d.mem().set(data, buf);
        return (ev.kind << 24) | data.length;
      },
      attachInterrupt() {},
      send(ptr, bytes) {
        // Long frames come in pieces (first unit 1 = more follows, 2 = last), as the firmware joins them.
        const text = d.str16(ptr, bytes);
        const marker = text.charCodeAt(0);
        if (marker === 1 || marker === 2) {
          d.partial = (d.partial ?? '') + text.slice(1);
          if (marker === 2) { d.sent.push(d.partial); d.partial = ''; }
          return;
        }
        d.partial = '';
        d.sent.push(text);
      },
      kvGet(k, kb, out, cap) {
        const v = d.kv.get(d.str16(k, kb));
        if (v === undefined) return -1;
        const b = Buffer.from(v, 'utf8');
        if (b.length > cap) return -1;
        d.mem().set(b, out);
        return b.length;
      },
      kvSet(k, kb, v, vb) { d.kv.set(d.str16(k, kb), d.str16(v, vb)); return 0; },
      epochMs() { return BigInt(1793544000000 + d.now); },
      setEpochMs() {},
      outputFailsafe() {},
      deviceId(out, cap) { const b = Buffer.from(d.id); d.mem().set(b, out); return b.length; },
      pinMode() {}, digitalWrite(p, v) { d.pins[p] = v; }, digitalRead(p) { return d.hw.din?.[p] ?? 1; }, analogRead(p) { return d.hw.adc?.[p] ?? 0; }, analogWrite() {},
      delay(ms) { d.now += ms; },
      delayMicroseconds() {},
      millis() { return BigInt(d.now); },
      micros() { return BigInt(d.now * 1000); },
      random(max) { return Math.floor(Math.random() * max); },
      print(ptr, bytes) { d.log += d.str16(ptr, bytes); },
      i2cBegin() { return 0; },
      i2cWrite(addr, ptr, len) { const x = d.hw.i2c?.[addr]; if (!x) return -1; x.write(d.mem().slice(ptr, ptr + len)); return 0; },
      i2cRead(addr, ptr, len) { const x = d.hw.i2c?.[addr]; if (!x) return -1; d.mem().set(x.read(len), ptr); return 0; },
      i2cFailsafe(addr, value) { (d.failsafe ??= {})[addr] = value; },
      uartOpen(port) { return d.hw.uart ? 0 : -1; },
      uartWrite(port, ptr, len) { d.hw.uart.write(Buffer.from(d.mem().slice(ptr, ptr + len))); return len; },
      uartRead(port, ptr, cap, timeout) {
        const got = d.hw.uart.read(cap);
        if (!got.length) { d.now += timeout; return 0; }
        d.mem().set(got, ptr);
        return got.length;
      },
      uartAvailable() { return d.hw.uart.rx.length; },
      spiBegin() { return 0; },
      spiDevice() { return 0; },
      spiTransfer(dev, ptr, len) {
        const bytes = d.mem().slice(ptr, ptr + len);
        const reply = d.hw.radio.transfer(bytes, d);
        d.mem().set(reply, ptr);
        return 0;
      },
      owReset(pin) { return d.bus(pin)?.reset() ?? 0; },
      owBit(pin, bit) { return d.bus(pin)?.bit(bit) ?? 1; },
      owWrite(pin, v) { for (let i = 0; i < 8; i++) d.bus(pin)?.bit((v >> i) & 1); },
      owRead(pin) { let v = 0; for (let i = 0; i < 8; i++) v |= (d.bus(pin)?.bit(1) ?? 1) << i; return v; },
      hmacSha256(k, kl, data, len, out) {
        const mac = crypto.createHmac('sha256', Buffer.from(d.mem().slice(k, k + kl))).update(Buffer.from(d.mem().slice(data, data + len))).digest();
        d.mem().set(mac, out);
        return 32;
      },
    };
    const env = {
      abort(msg, file, line, col) {
        const read = (p) => (p ? d.str16(p, new Uint32Array(d.memory.buffer, p - 4, 1)[0]) : '');
        throw new Error(`abort: ${read(msg)} at ${read(file)}:${line}:${col}`);
      },
      seed() { return Math.random() * 1e9; },
      trace() {},
    };
    return { esp, env };
  }
  async run(wasm) {
    const { instance } = await WebAssembly.instantiate(wasm, this.imports());
    this.memory = instance.exports.memory;
    if (instance.exports._start) instance.exports._start();
    instance.exports.__lab_run();
    return this;
  }
  /** Frames sent to the cloud, parsed. */
  frames() { return this.sent.map((s) => JSON.parse(s)); }
}

export const EV_GPIO = 1;
export const EV_MESSAGE = 2;
export const msg = (obj) => ({ kind: EV_MESSAGE, data: Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)) });
export const EV_NET = 3;
/** Network change: Wi-Fi, cloud link and (runtime 0.12+) clock quality 0 none, 1 approximate, 2 synced. */
export const net = (wifi, cloud, clock = 2) => ({ kind: EV_NET, data: Buffer.from([wifi ? 1 : 0, cloud ? 1 : 0, clock]) });
export const gpio = (pin) => ({ kind: EV_GPIO, data: Buffer.from([pin, 1]) });

// ---- Modbus RTU slave ------------------------------------------------------------------------

export function crc16(buf) {
  let crc = 0xffff;
  for (const b of buf) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1; }
  return crc;
}

export class ModbusSlave {
  constructor(unit, { holding = {}, input = {}, coils = {} } = {}) {
    this.unit = unit; this.holding = holding; this.input = input; this.coils = coils;
    this.rx = []; this.requests = []; this.corruptNext = false; this.silent = false;
  }
  write(bytes) {
    const f = [...bytes];
    this.requests.push(f);
    if (this.silent || f[0] !== this.unit) return;
    const crc = crc16(f.slice(0, -2));
    if ((crc & 0xff) !== f.at(-2) || crc >> 8 !== f.at(-1)) return;
    const fn = f[1];
    const a = (f[2] << 8) | f[3];
    const b = (f[4] << 8) | f[5];
    let reply;
    const exception = (code) => [this.unit, fn | 0x80, code];
    if (fn === 3 || fn === 4) {
      const table = fn === 3 ? this.holding : this.input;
      if (!(a in table)) reply = exception(2);
      else { reply = [this.unit, fn, b * 2]; for (let i = 0; i < b; i++) { const v = table[a + i] ?? 0; reply.push(v >> 8, v & 0xff); } }
    } else if (fn === 1) {
      const bytes = Math.ceil(b / 8); reply = [this.unit, fn, bytes];
      for (let i = 0; i < bytes; i++) { let v = 0; for (let k = 0; k < 8; k++) if (this.coils[a + i * 8 + k]) v |= 1 << k; reply.push(v); }
    } else if (fn === 6) { this.holding[a] = b; reply = f.slice(0, 6); }
    else if (fn === 5) { this.coils[a] = b === 0xff00; reply = f.slice(0, 6); }
    else if (fn === 16) { for (let i = 0; i < b; i++) this.holding[a + i] = (f[7 + i * 2] << 8) | f[8 + i * 2]; reply = f.slice(0, 6); }
    else reply = exception(1);
    const c = crc16(reply);
    reply.push(c & 0xff, c >> 8);
    if (this.corruptNext) { reply[reply.length - 1] ^= 0xff; this.corruptNext = false; }
    this.rx.push(...reply);
  }
  read(max) { return Buffer.from(this.rx.splice(0, max)); }
}

// ---- 1-Wire bus with DS18B20 probes (bit level) --------------------------------------------

function crc8(bytes) {
  let crc = 0;
  for (let b of bytes) for (let i = 0; i < 8; i++) { const mix = (crc ^ b) & 1; crc >>= 1; if (mix) crc ^= 0x8c; b >>= 1; }
  return crc;
}

export function romFor(serial) {
  const rom = [0x28, ...serial];
  rom.push(crc8(rom));
  return rom;
}

export class OneWireBus {
  constructor(probes) { this.probes = probes; this.state = 'idle'; this.converted = false; }
  reset() { this.state = 'rom'; this.bits = []; this.selected = null; return this.probes.length ? 1 : 0; }
  bit(b) {
    switch (this.state) {
      case 'rom': case 'func': case 'match': {
        this.bits.push(b);
        if (this.state === 'match' && this.bits.length === 64) {
          const rom = []; for (let i = 0; i < 8; i++) rom.push(this.bits.slice(i * 8, i * 8 + 8).reduce((v, x, k) => v | (x << k), 0));
          this.selected = this.probes.filter((p) => p.rom.every((v, i) => v === rom[i]));
          this.state = 'func'; this.bits = [];
          return 1;
        }
        if (this.state === 'match' || this.bits.length < 8) return 1;
        const cmd = this.bits.reduce((v, x, k) => v | (x << k), 0);
        this.bits = [];
        if (this.state === 'rom') {
          if (cmd === 0xcc) { this.selected = this.probes; this.state = 'func'; }
          else if (cmd === 0x55) this.state = 'match';
          else if (cmd === 0xf0) { this.state = 'search'; this.active = [...this.probes]; this.pos = 0; this.phase = 0; }
        } else if (cmd === 0x44) { this.converted = true; this.state = 'idle'; }
        else if (cmd === 0xbe) {
          const p = this.selected?.[0];
          if (!p) { this.state = 'idle'; return 1; }
          const raw = Math.round((this.converted ? p.celsius : 85) * 16) & 0xffff;
          const pad = [raw & 0xff, raw >> 8, 0x4b, 0x46, 0x7f, 0xff, 0x0c, 0x10];
          pad.push(crc8(pad));
          if (p.corrupt) pad[8] ^= 1;
          this.out = []; for (const byte of pad) for (let k = 0; k < 8; k++) this.out.push((byte >> k) & 1);
          this.state = 'read';
        }
        return 1;
      }
      case 'read': return this.out.length ? this.out.shift() : 1;
      case 'search': {
        const bitOf = (p) => (p.rom[this.pos >> 3] >> (this.pos & 7)) & 1;
        if (this.phase === 0) { this.phase = 1; return this.active.every((p) => bitOf(p) === 1) ? 1 : 0; } // wired AND
        if (this.phase === 1) { this.phase = 2; return this.active.every((p) => bitOf(p) === 0) ? 1 : 0; }
        this.active = this.active.filter((p) => bitOf(p) === b);
        this.pos++; this.phase = 0;
        if (this.pos === 64) this.state = 'idle';
        return 1;
      }
      default: return 1;
    }
  }
}

// ---- SX127x radio (register level) ----------------------------------------------------------

export class Sx127x {
  constructor() {
    this.regs = new Uint8Array(0x80);
    this.regs[0x42] = 0x12;
    this.fifo = new Uint8Array(256);
    this.sentPackets = [];
    this.inbox = [];
  }
  transfer(bytes) {
    const addr = bytes[0] & 0x7f;
    const write = (bytes[0] & 0x80) !== 0;
    const reply = new Uint8Array(bytes.length);
    if (write) {
      const v = bytes[1];
      if (addr === 0x00) { this.fifo[this.regs[0x0d]] = v; this.regs[0x0d] = (this.regs[0x0d] + 1) & 0xff; }
      else if (addr === 0x12) this.regs[0x12] &= ~v; // write 1 to clear
      else {
        this.regs[addr] = v;
        if (addr === 0x01 && (v & 7) === 3) { // TX
          const len = this.regs[0x22];
          this.sentPackets.push(Buffer.from(this.fifo.slice(this.regs[0x0e], this.regs[0x0e] + len)));
          this.regs[0x12] |= 0x08;
        }
      }
    } else if (addr === 0x00) { reply[1] = this.fifo[this.regs[0x0d]]; this.regs[0x0d] = (this.regs[0x0d] + 1) & 0xff; }
    else reply[1] = this.regs[addr];
    return reply;
  }
  /** A packet arriving over the air (the radio must be in RX continuous). */
  deliver(packet, rssiReg = 100) {
    if ((this.regs[0x01] & 7) !== 5) return false;
    this.fifo.set(packet, 0);
    this.regs[0x13] = packet.length;
    this.regs[0x10] = 0;
    this.regs[0x1a] = rssiReg;
    this.regs[0x19] = 24;
    this.regs[0x12] |= 0x40;
    return true;
  }
}

// ---- PCF8574 I2C expander ---------------------------------------------------------------------

export class Pcf8574 {
  constructor(pins = 0xff) { this.latch = 0xff; this.pins = pins; this.writes = 0; }
  write(bytes) { this.latch = bytes[bytes.length - 1]; this.writes++; }
  read() { return Uint8Array.of(this.pins & this.latch); }
  /** Relay n (1-based) energised: its bit is low (KinCony relays are active low). */
  on(n) { return ((this.latch >> (n - 1)) & 1) === 0; }
  /** Input n (1-based) closed to GND. */
  close(n) { this.pins &= ~(1 << (n - 1)); }
  open(n) { this.pins |= 1 << (n - 1); }
}
