/**
 * The AssemblyScript source of the `lab` framework that device programs import:
 *
 *   import { App } from "lab";
 *
 * A program declares a device model (sensors, settings, outputs, inputs, commands, state
 * machines). The framework runs an event loop on top of the firmware's event queue, reports the
 * model to ESP Lab as elp/1 JSON frames (hello + manifest, state, evt, ack) and applies
 * commands and config coming back. It is handed to the compiler as `lib/lab.ts`.
 *
 * AssemblyScript has no closures: handlers are top-level functions.
 */
export const LAB_LIB_SOURCE = String.raw`// ESP Lab framework (module "lab"): state machines, events, device model, cloud link.
import { pinMode, digitalWrite, digitalRead, millis, print, i2cBegin, i2cWrite, i2cRead, OUTPUT, INPUT, INPUT_PULLUP } from "esp";

@external("esp", "waitEvent") declare function waitEventRaw(timeoutMs: i32, buf: usize, cap: i32): i32;
@external("esp", "attachInterrupt") declare function attachInterrupt(pin: i32, mode: i32): void;
@external("esp", "send") declare function sendRaw(ptr: usize, bytes: i32): void;
@external("esp", "kvGet") declare function kvGetRaw(key: usize, keyBytes: i32, out: usize, cap: i32): i32;
@external("esp", "kvSet") declare function kvSetRaw(key: usize, keyBytes: i32, value: usize, valueBytes: i32): i32;
@external("esp", "epochMs") declare function epochMsRaw(): i64;
@external("esp", "setEpochMs") declare function setEpochMs(ms: i64): void;
@external("esp", "outputFailsafe") declare function outputFailsafe(pin: i32, level: i32): void;
@external("esp", "i2cFailsafe") declare function i2cFailsafe(address: i32, value: i32): void;
@external("esp", "deviceId") declare function deviceIdRaw(out: usize, cap: i32): i32;

const EV_GPIO = 1;
const EV_MESSAGE = 2;
const EV_NET = 3;
const BUF_SIZE = 2048;
const buffer = new Uint8Array(BUF_SIZE);

// ---- small utilities ---------------------------------------------------------------------

/** Milliseconds since 1970 (0 until ESP Lab has sent the time). */
export function epochMs(): i64 { return epochMsRaw(); }

// ---- links: where frames go and come from ----------------------------------------------------
//
// By default frames go to ESP Lab (the cloud link, or the console). A LoRa node replaces the
// transport with its radio; a gateway receives its nodes' frames from the hub ("sub" frames).

let transport: ((ptr: usize, bytes: i32) => void) | null = null;
let subHandler: ((text: string) => void) | null = null;
const pinWatchPins: i32[] = [];
const pinWatchFns: (() => void)[] = [];

function transmit(ptr: usize, bytes: i32): void {
  const t = transport;
  if (t != null) t(ptr, bytes);
  else sendRaw(ptr, bytes);
}

/** Sends this device's frames through fn (UTF-16 text at ptr, bytes long) instead of the cloud link. */
export function setTransport(fn: (ptr: usize, bytes: i32) => void): void { transport = fn; }

/** Hands a frame received some other way (a radio) to the app, as if it came from ESP Lab. */
export function deliver(text: string): void {
  const app = theApp;
  if (app != null) app.handleMessage(text);
}

/** Frames ESP Lab sends to this gateway's sub-devices: {"t":"sub","id":"<node>","f":{...}}. */
export function onSubFrame(fn: (text: string) => void): void { subHandler = fn; }

/** Sends JSON text straight to ESP Lab (the cloud link or console), whatever the transport. */
export function sendToHub(json: string): void {
  sendRaw(changetype<usize>(json), json.length << 1);
}

/**
 * Calls fn when the pin changes (an interrupt wakes the event loop) and at least once a second:
 * radios and other chips that signal with a pin.
 */
export function watchPin(pin: i32, fn: () => void): void {
  attachInterrupt(pin, 3);
  pinWatchPins.push(pin);
  pinWatchFns.push(fn);
}

function sendFrame(json: string): void {
  transmit(changetype<usize>(json), json.length << 1);
}

/** Stored text (NVS) or null. Keys longer than 15 characters are cut. */
export function loadText(key: string): string | null {
  const n = kvGetRaw(changetype<usize>(key), key.length << 1, buffer.dataStart, BUF_SIZE);
  return n < 0 ? null : String.UTF8.decodeUnsafe(buffer.dataStart, n);
}

/** Stores text that survives restarts (NVS). */
export function saveText(key: string, value: string): bool {
  return kvSetRaw(changetype<usize>(key), key.length << 1, changetype<usize>(value), value.length << 1) == 0;
}

export function jsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c == 34) out += '\\"';
    else if (c == 92) out += "\\\\";
    else if (c == 10) out += "\\n";
    else if (c < 32) out += " ";
    else out += String.fromCharCode(c);
  }
  return out + '"';
}

export function jsonNumber(v: f64): string {
  if (!isFinite(v)) return "null";
  if (v == Math.floor(v) && Math.abs(v) < 1e15) return (<i64>v).toString();
  return (Math.round(v * 1000) / 1000).toString();
}

/**
 * Builds one outgoing frame in a fixed buffer (UTF-16, as the firmware's send() takes) and sends
 * it without creating strings: programs have one 64 KiB page, so frames must not make garbage.
 */
class Writer {
  // buf[0] is reserved for a marker; the text starts at buf[1]. A frame longer than the buffer
  // (the hello of an app with many settings and labels) is streamed to the firmware in pieces:
  // marker 1 = "more follows", marker 2 = "last piece" (firmware 0.10+ joins them into one
  // frame). Radio transports (LoRa) need the whole frame, so for them the buffer grows instead.
  buf: Uint16Array = new Uint16Array(2049);
  n: i32 = 1;
  streamed: bool = false;
  overflow: bool = false;
  begin(): Writer { this.n = 1; this.streamed = false; this.overflow = false; return this; }
  ch(c: i32): Writer {
    if (this.n >= this.buf.length) this.full();
    if (!this.overflow) unchecked(this.buf[this.n++] = <u16>c);
    return this;
  }
  full(): void {
    if (transport != null) {
      if (this.buf.length >= 16385) { this.overflow = true; return; }
      const bigger = new Uint16Array((this.buf.length - 1) * 2 + 1);
      bigger.set(this.buf);
      this.buf = bigger;
      return;
    }
    unchecked(this.buf[0] = 1);
    sendRaw(this.buf.dataStart, this.n << 1);
    this.streamed = true;
    this.n = 1;
  }
  raw(s: string): Writer { for (let i = 0; i < s.length; i++) this.ch(s.charCodeAt(i)); return this; }
  str(s: string): Writer {
    this.ch(34);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c == 34 || c == 92) { this.ch(92); this.ch(c); }
      else if (c == 10) { this.ch(92); this.ch(110); }
      else if (c < 32) this.ch(32);
      else this.ch(c);
    }
    return this.ch(34);
  }
  int(v: i64): Writer {
    if (v < 0) { this.ch(45); v = -v; }
    if (v >= 10) this.int(v / 10);
    return this.ch(<i32>(48 + v % 10));
  }
  num(v: f64): Writer {
    if (!isFinite(v)) return this.raw("null");
    if (v == Math.floor(v) && Math.abs(v) < 1e15) return this.int(<i64>v);
    const r = Math.round(v * 1000) / 1000;
    const whole = <i64>Math.floor(Math.abs(r));
    let frac = <i64>Math.round((Math.abs(r) - <f64>whole) * 1000);
    if (r < 0) this.ch(45);
    this.int(whole);
    if (frac > 0) {
      this.ch(46);
      if (frac < 100) this.ch(48);
      if (frac < 10) this.ch(48);
      while (frac % 10 == 0) frac /= 10;
      this.int(frac);
    }
    return this;
  }
  bool(b: bool): Writer { return this.raw(b ? "true" : "false"); }
  /** "key": */
  key(k: string, first: bool = false): Writer { if (!first) this.ch(44); return this.str(k).ch(58); }
  send(): void {
    if (this.overflow) { print("[lab] frame too large, dropped\n"); return; }
    if (this.streamed) {
      unchecked(this.buf[0] = 2);
      sendRaw(this.buf.dataStart, this.n << 1);
      return;
    }
    transmit(this.buf.dataStart + 2, (this.n - 1) << 1);
  }
}

const w = new Writer();

/** A parsed JSON value (enough for elp/1 frames). */
export class Json {
  kind: i32 = 0; // 0 null, 1 bool, 2 number, 3 string, 4 object, 5 array
  b: bool = false;
  n: f64 = 0;
  s: string = "";
  keys: string[] = [];
  items: Json[] = [];

  get(key: string): Json | null {
    for (let i = 0; i < this.keys.length; i++) if (this.keys[i] == key) return this.items[i];
    return null;
  }
  str(key: string): string {
    const v = this.get(key);
    return v != null && v.kind == 3 ? v.s : "";
  }
  num(key: string, fallback: f64 = NaN): f64 {
    const v = this.get(key);
    if (v == null) return fallback;
    if (v.kind == 2) return v.n;
    if (v.kind == 1) return v.b ? 1 : 0;
    return fallback;
  }
  get isNumber(): bool { return this.kind == 2 || this.kind == 1; }
  get number(): f64 { return this.kind == 1 ? (this.b ? 1 : 0) : this.n; }
}

class JsonParser {
  i: i32 = 0;
  constructor(public t: string) {}
  ws(): void { while (this.i < this.t.length && this.t.charCodeAt(this.i) <= 32) this.i++; }
  value(): Json {
    this.ws();
    const v = new Json();
    if (this.i >= this.t.length) return v;
    const c = this.t.charCodeAt(this.i);
    if (c == 123) { // {
      v.kind = 4; this.i++;
      this.ws();
      if (this.t.charCodeAt(this.i) == 125) { this.i++; return v; }
      while (this.i < this.t.length) {
        this.ws();
        const key = this.string();
        this.ws();
        if (this.t.charCodeAt(this.i) == 58) this.i++;
        v.keys.push(key);
        v.items.push(this.value());
        this.ws();
        const d = this.t.charCodeAt(this.i++);
        if (d != 44) break;
      }
    } else if (c == 91) { // [
      v.kind = 5; this.i++;
      this.ws();
      if (this.t.charCodeAt(this.i) == 93) { this.i++; return v; }
      while (this.i < this.t.length) {
        v.items.push(this.value());
        this.ws();
        const d = this.t.charCodeAt(this.i++);
        if (d != 44) break;
      }
    } else if (c == 34) {
      v.kind = 3; v.s = this.string();
    } else if (c == 116 || c == 102) { // true / false
      v.kind = 1; v.b = c == 116; this.i += v.b ? 4 : 5;
    } else if (c == 110) { // null
      this.i += 4;
    } else {
      const start = this.i;
      while (this.i < this.t.length) {
        const d = this.t.charCodeAt(this.i);
        if ((d >= 48 && d <= 57) || d == 45 || d == 43 || d == 46 || d == 101 || d == 69) this.i++;
        else break;
      }
      v.kind = 2; v.n = parseFloat(this.t.substring(start, this.i));
    }
    return v;
  }
  string(): string {
    if (this.t.charCodeAt(this.i) != 34) return "";
    this.i++;
    let out = "";
    while (this.i < this.t.length) {
      const c = this.t.charCodeAt(this.i++);
      if (c == 34) break;
      if (c == 92) {
        const e = this.t.charCodeAt(this.i++);
        if (e == 110) out += "\n";
        else if (e == 116) out += "\t";
        else if (e == 117) { out += String.fromCharCode(<i32>parseInt(this.t.substring(this.i, this.i + 4), 16)); this.i += 4; }
        else out += String.fromCharCode(e);
      } else out += String.fromCharCode(c);
    }
    return out;
  }
}

export function parseJson(text: string): Json { return new JsonParser(text).value(); }

/** The value of the frame's "t" field without parsing the whole frame. */
function frameType(text: string): string {
  const at = text.indexOf('"t"');
  if (at < 0) return "";
  let i = at + 3;
  while (i < text.length && (text.charCodeAt(i) == 58 || text.charCodeAt(i) <= 32)) i++;
  if (i >= text.length || text.charCodeAt(i) != 34) return "";
  const end = text.indexOf('"', i + 1);
  return end < 0 || end - i > 12 ? "" : text.substring(i + 1, end);
}

function alwaysTrue(): bool { return true; }
function nothing(): void {}

// ---- device model ------------------------------------------------------------------------

/** A measured value the device reports (temperature, pressure, level...). */
export class Sensor {
  value: f64 = NaN;
  reported: f64 = NaN;
  dirty: bool = false;
  nextAt: i64 = 0;
  constructor(public app: App, public name: string, public unit: string, public read: () => f64, public everyMs: i32, public deadband: f64) {}
  /** The name people see in ESP Lab and dashboards ("Water temperature"). */
  label(text: string): Sensor { this.app.label(this.name, text); return this; }
  /** Sets the value (for sensors without a read function). */
  set(v: f64): void {
    this.value = v;
    // Report a change: a reading appearing or disappearing, or a move of at least the dead band
    // (any change when the dead band is 0).
    const moved = this.deadband > 0 ? Math.abs(v - this.reported) >= this.deadband : v != this.reported;
    if (isNaN(this.reported) != isNaN(v) || (!isNaN(v) && moved)) {
      this.dirty = true;
      this.app.changed = true;
    }
  }
  get valid(): bool { return !isNaN(this.value); }
}

/** A value users can change from ESP Lab, apps and websites (setpoints, limits, modes). Saved on the device. */
export class Setting {
  value: f64;
  dirty: bool = true;
  constructor(public app: App, public name: string, public unit: string, public def: f64, public min: f64, public max: f64) {
    this.value = def;
  }
  label(text: string): Setting { this.app.label(this.name, text); return this; }
  set(v: f64): void {
    if (isNaN(v)) return;
    const c = v < this.min ? this.min : v > this.max ? this.max : v;
    if (c == this.value) return;
    this.value = c;
    this.dirty = true;
    this.app.changed = true;
    saveText("s." + this.name, jsonNumber(c));
  }
}

/**
 * A PCF8574 / PCF8574A 8-bit I2C port expander, as KinCony boards use for their relays and
 * inputs (addresses 0x20-0x27, PCF8574A 0x38-0x3F). Outputs on it get the same protections as
 * GPIO outputs (interlocks, min on/off, failsafe: the firmware writes the failsafe state to the
 * expander if the program stops). Pins are quasi-bidirectional: an output bit at 1 is a weak
 * pull-up, so inputs are bits left at 1 and read low when a switch pulls them to GND.
 */
export class Pcf8574 {
  latch: i32 = 0xffff;     // the port's output levels (high = released / input)
  failsafeLatch: i32 = 0xffff;
  cache: i32 = 0xffff;
  readAt: i64 = -1;
  ok: bool;
  /** Port bytes per transfer: 1 (PCF8574) or 2 (PCF8575). */
  width: i32;
  buf: Uint8Array;
  constructor(public address: i32, sda: i32 = 4, scl: i32 = 15, width: i32 = 1) {
    this.width = width;
    this.buf = new Uint8Array(width);
    i2cBegin(sda, scl, 100000);
    this.ok = this.send();
    if (!this.ok) print("[lab] no " + this.chip() + " answered at 0x" + (<u32>address).toString(16) + "\n");
    i2cFailsafe(address, this.failsafeValue());
  }
  chip(): string { return this.width == 2 ? "PCF8575" : "PCF8574"; }
  /** Pins on the expander: 8 or 16. */
  get pins(): i32 { return this.width * 8; }
  private send(): bool {
    this.buf[0] = <u8>(this.latch & 0xff);
    if (this.width == 2) this.buf[1] = <u8>((this.latch >> 8) & 0xff);
    return i2cWrite(this.address, this.buf) == 0;
  }
  private failsafeValue(): i32 {
    // Bit 16 tells the firmware to write both ports of a PCF8575.
    return this.width == 2 ? (this.failsafeLatch & 0xffff) | 0x10000 : this.failsafeLatch & 0xff;
  }
  writeBit(bit: i32, level: i32): void {
    this.latch = level ? (this.latch | (1 << bit)) : (this.latch & ~(1 << bit));
    this.ok = this.send();
  }
  /** Set every pin at once (bit n = pin n, P00-P07 then P10-P17 on a PCF8575). */
  writeAll(levels: i32): void {
    this.latch = levels & 0xffff;
    this.ok = this.send();
  }
  /** All pin levels (read at most once per millisecond). */
  readAll(): i32 {
    const now = millis();
    if (now != this.readAt) {
      const d = i2cRead(this.address, this.width);
      if (d != null) this.cache = this.width == 2 ? (<i32>d[0]) | (<i32>d[1] << 8) : <i32>d[0];
      this.ok = d != null;
      this.readAt = now;
    }
    return this.cache;
  }
  /** A pin level. */
  readBit(bit: i32): i32 { return (this.readAll() >> bit) & 1; }
  setFailsafe(bit: i32, level: i32): void {
    this.failsafeLatch = level ? (this.failsafeLatch | (1 << bit)) : (this.failsafeLatch & ~(1 << bit));
    i2cFailsafe(this.address, this.failsafeValue());
  }
  /** "PCF8575 0x20 P13" style label for pin n. */
  pinName(bit: i32): string {
    const where = this.chip() + " 0x" + (<u32>this.address).toString(16);
    return this.width == 2 ? where + " P" + (bit >> 3).toString() + (bit & 7).toString() : where + " P" + bit.toString();
  }
}

/**
 * A PCF8575 16-bit I2C port expander (addresses 0x20-0x27). Pins are numbered 0-15: 0-7 are
 * P00-P07, 8-15 are P10-P17. Works everywhere a Pcf8574 does (relayAt, inputAt).
 */
export class Pcf8575 extends Pcf8574 {
  constructor(address: i32, sda: i32 = 21, scl: i32 = 22) {
    super(address, sda, scl, 2);
  }
}

/** A switched output: relay, contactor, valve, LED. */
export class Output {
  isOn: bool = false;
  want: bool = false;
  dirty: bool = true;
  changedAt: i64 = -1000000000;
  minOnMs: i32 = 0;
  minOffMs: i32 = 0;
  requires: Output | null = null;
  failsafeOn: bool = false;
  /** On an expander instead of a GPIO (pin is then -1), with a label such as "R3". */
  expander: Pcf8574 | null = null;
  bit: i32 = -1;
  at: string = "";
  constructor(public app: App, public name: string, public pin: i32, public activeLow: bool) {}

  level(high: bool): void {
    const x = this.expander;
    if (x != null) x.writeBit(this.bit, high ? 1 : 0);
    else digitalWrite(this.pin, high ? 1 : 0);
  }

  label(text: string): Output { this.app.label(this.name, text); return this; }
  /** Only allowed on while "other" is on (e.g. heater needs the pump). Turns off with it. */
  interlock(other: Output): Output { this.requires = other; return this; }
  /** Minimum time on before it may turn off (ms). */
  minOn(ms: i32): Output { this.minOnMs = ms; return this; }
  /** Minimum time off before it may turn on again (ms), e.g. compressor protection. */
  minOff(ms: i32): Output { this.minOffMs = ms; return this; }
  /** State when the program stops or crashes (default off). */
  failsafe(on: bool): Output {
    this.failsafeOn = on;
    const x = this.expander;
    if (x != null) x.setFailsafe(this.bit, on != this.activeLow ? 1 : 0);
    else outputFailsafe(this.pin, on != this.activeLow ? 1 : 0);
    return this;
  }

  on(): void { this.set(true); }
  off(): void { this.set(false); }
  toggle(): void { this.set(!this.want); }
  set(on: bool): void {
    if (on == this.want) return; // asking again for the same state is not a change
    this.want = on;
    this.app.changed = true;
  }

  apply(now: i64): void {
    let target = this.want;
    const req = this.requires;
    if (target && req != null && !req.isOn) target = false;
    if (target == this.isOn) return;
    const held = now - this.changedAt;
    let safety = false; // an interlock drop is immediate
    if (!target && req != null) safety = !req.isOn;
    if (!safety && target && held < this.minOffMs) return;
    if (!safety && !target && held < this.minOnMs) return;
    this.isOn = target;
    this.changedAt = now;
    this.level(target != this.activeLow);
    this.dirty = true;
  }
  /** When a blocked change (min on/off time) can happen. */
  pendingAt(): i64 {
    if (this.want == this.isOn) return i64.MAX_VALUE;
    return this.changedAt + <i64>(this.want ? this.minOffMs : this.minOnMs);
  }
}

/** A digital input with debounce: switches, buttons, float switches, door contacts. */
export class Input {
  value: bool = false;
  raw: bool = false;
  rawAt: i64 = 0;
  dirty: bool = true;
  onEvent: string;
  offEvent: string;
  expander: Pcf8574 | null = null;
  bit: i32 = -1;
  at: string = "";
  constructor(public app: App, public name: string, public pin: i32, public activeLow: bool, public debounceMs: i32) {
    this.onEvent = name + ".on";
    this.offEvent = name + ".off";
  }
  label(text: string): Input { this.app.label(this.name, text); return this; }
  sample(now: i64): void {
    const x = this.expander;
    const r = ((x != null ? x.readBit(this.bit) : digitalRead(this.pin)) == 1) != this.activeLow;
    if (r != this.raw) { this.raw = r; this.rawAt = now; }
    if (this.raw != this.value && now - this.rawAt >= this.debounceMs) {
      this.value = this.raw;
      this.dirty = true;
      this.app.changed = true;
      this.app.dispatch(this.value ? this.onEvent : this.offEvent);
    }
  }
}

/** Arguments of a command from ESP Lab, an app or a website. */
export class Command {
  constructor(public name: string, public handler: (args: Args) => void) {}
}

export class Args {
  result: string = "null";
  error: string = "";
  constructor(public value: Json) {}
  /** The command's value as a number (NaN when absent). */
  get number(): f64 { return this.value.isNumber ? this.value.number : NaN; }
  get text(): string { return this.value.kind == 3 ? this.value.s : ""; }
  /** A named argument: {"v": {"minutes": 30}}. */
  num(key: string, fallback: f64 = NaN): f64 { return this.value.kind == 4 ? this.value.num(key, fallback) : fallback; }
  str(key: string): string { return this.value.kind == 4 ? this.value.str(key) : ""; }
  reply(v: f64): void { this.result = jsonNumber(v); }
  replyText(s: string): void { this.result = jsonString(s); }
  fail(message: string): void { this.error = message; }
}

class Transition {
  constructor(public from: i32, public event: string, public guard: () => bool, public guardName: string, public to: i32) {}
}

/** A finite state machine. States are declared up front; transitions are a table. */
export class Machine {
  current: i32 = 0;
  enteredAt: i64 = 0;
  dirty: bool = true;
  started: bool = false;
  transitions: Transition[] = [];
  enters: Array<() => void> = [];
  exits: Array<() => void> = [];
  durings: Array<() => void> = [];
  timeoutMs: i32[] = [];
  timeoutTo: i32[] = [];

  transitionEvent: string;

  constructor(public app: App, public name: string, public states: string[]) {
    this.transitionEvent = name + ".transition";
    for (let i = 0; i < states.length; i++) {
      this.enters.push(nothing);
      this.exits.push(nothing);
      this.durings.push(nothing);
      this.timeoutMs.push(0);
      this.timeoutTo.push(0);
    }
  }

  index(state: string): i32 {
    for (let i = 0; i < this.states.length; i++) if (this.states[i] == state) return i;
    abort("machine " + this.name + " has no state " + state);
    return 0;
  }

  /** from --event [guard]--> to. Use the event "tick" for conditions checked continuously. */
  on(from: string, event: string, guard: () => bool, to: string, label: string = ""): Machine {
    this.transitions.push(new Transition(this.index(from), event, guard, label, this.index(to)));
    return this;
  }
  /** from --event--> to, without a condition. */
  go(from: string, event: string, to: string): Machine {
    this.transitions.push(new Transition(this.index(from), event, alwaysTrue, "", this.index(to)));
    return this;
  }
  /** From any state on an event (faults, emergency stop). */
  any(event: string, to: string, guard: () => bool = alwaysTrue, label: string = ""): Machine {
    this.transitions.push(new Transition(-1, event, guard, label, this.index(to)));
    return this;
  }
  /** Leave "state" for "to" after ms (cranking limits, warm-up, max run time). */
  timeout(state: string, ms: i32, to: string): Machine {
    const i = this.index(state);
    this.timeoutMs[i] = ms;
    this.timeoutTo[i] = this.index(to);
    return this;
  }
  enter(state: string, fn: () => void): Machine { this.enters[this.index(state)] = fn; return this; }
  exit(state: string, fn: () => void): Machine { this.exits[this.index(state)] = fn; return this; }
  /** Called on every tick while in "state". */
  during(state: string, fn: () => void): Machine { this.durings[this.index(state)] = fn; return this; }

  get state(): string { return this.states[this.current]; }
  is(state: string): bool { return this.states[this.current] == state; }
  /** Time in the current state (ms). */
  get elapsed(): i64 { return millis() - this.enteredAt; }

  /** Moves to a state now (from code). */
  goto(state: string, cause: string = "code"): void { this.change(this.index(state), cause); }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.enteredAt = millis();
    this.enters[this.current]();
  }

  change(to: i32, cause: string): void {
    const from = this.current;
    this.exits[from]();
    this.current = to;
    this.enteredAt = millis();
    this.dirty = true;
    this.app.changed = true;
    this.app.seq++;
    w.begin().raw('{"t":"evt"').key("n").str(this.transitionEvent).key("v").ch(123)
      .key("from", true).str(this.states[from]).key("to").str(this.states[to]).key("on").str(cause)
      .raw('},"seq":').int(this.app.seq).ch(125).send();
    this.enters[to]();
  }

  /** Runs the first matching transition; returns whether the state changed. */
  dispatch(event: string): bool {
    for (let i = 0; i < this.transitions.length; i++) {
      const t = this.transitions[i];
      if ((t.from == this.current || (t.from == -1 && t.to != this.current)) && t.event == event && t.guard()) {
        this.change(t.to, event);
        return true;
      }
    }
    return false;
  }

  checkTimeout(now: i64): bool {
    const ms = this.timeoutMs[this.current];
    if (ms > 0 && now - this.enteredAt >= ms) {
      this.change(this.timeoutTo[this.current], "timeout");
      return true;
    }
    return false;
  }

  nextTimeout(): i64 {
    const ms = this.timeoutMs[this.current];
    return ms > 0 ? this.enteredAt + ms : i64.MAX_VALUE;
  }

  writeManifest(): void {
    w.ch(123).key("n", true).str(this.name).key("states").ch(91);
    for (let i = 0; i < this.states.length; i++) { if (i) w.ch(44); w.str(this.states[i]); }
    w.ch(93).key("tr").ch(91);
    for (let i = 0; i < this.transitions.length; i++) {
      const t = this.transitions[i];
      if (i) w.ch(44);
      w.ch(123).key("f", true);
      if (t.from < 0) w.str("*"); else w.str(this.states[t.from]);
      w.key("e").str(t.event).key("t").str(this.states[t.to]);
      if (t.guardName.length) w.key("g").str(t.guardName);
      w.ch(125);
    }
    w.ch(93).key("timeouts").ch(91);
    let first = true;
    for (let i = 0; i < this.states.length; i++) {
      if (this.timeoutMs[i] <= 0) continue;
      if (!first) w.ch(44);
      first = false;
      w.ch(123).key("s", true).str(this.states[i]).key("ms").int(this.timeoutMs[i]).key("t").str(this.states[this.timeoutTo[i]]).ch(125);
    }
    w.ch(93).ch(125);
  }
}

class Timer {
  constructor(public fn: () => void, public periodMs: i32, public nextAt: i64, public repeat: bool) {}
}

class Hook {
  constructor(public name: string, public fn: () => void) {}
}

class Schedule {
  lastDay: i64 = -1;
  constructor(public minuteOfDay: i32, public fn: () => void, public label: string) {}
}

let theApp: App | null = null;

/** The device application. Create exactly one, at the top of main.ts. */
export class App {
  sensors: Sensor[] = [];
  settings: Setting[] = [];
  outputs: Output[] = [];
  inputs: Input[] = [];
  commands: Command[] = [];
  machines: Machine[] = [];
  timers: Timer[] = [];
  hooks: Hook[] = [];
  schedules: Schedule[] = [];
  events: string[] = [];
  labelKeys: string[] = [];
  labelTexts: string[] = [];
  changed: bool = true;
  tickMs: i32 = 1000;
  utcOffsetMin: i32 = 0;
  online: bool = false;
  cfgVersion: i32 = 0;
  /** Settings changed on the device's local page and not yet confirmed by the hub. */
  localCfg: string[] = [];
  /** The firmware's clock: 0 not set, 1 approximate (restored after a restart), 2 synced. */
  clock: i32 = 0;
  lastTick: i64 = 0;
  seq: i32 = 0;

  constructor(public name: string, public version: string = "1.0.0") {
    theApp = this;
  }

  // -- declaring the model --

  /** A measured value. "read" is called every "everyMs"; changes smaller than "deadband" are not reported. */
  sensor(name: string, unit: string, read: () => f64, everyMs: i32 = 1000, deadband: f64 = 0): Sensor {
    const s = new Sensor(this, name, unit, read, everyMs, deadband);
    this.sensors.push(s);
    return s;
  }
  /** A value set from code with .set(v) (no read function). */
  value(name: string, unit: string = "", deadband: f64 = 0): Sensor {
    const s = new Sensor(this, name, unit, nanRead, 0, deadband);
    this.sensors.push(s);
    return s;
  }
  /** A user-adjustable setting with limits; kept across restarts and synced with ESP Lab. */
  setting(name: string, unit: string, def: f64, min: f64 = -Infinity, max: f64 = Infinity): Setting {
    const s = new Setting(this, name, unit, def, min, max);
    const stored = loadText("s." + name);
    if (stored != null) s.value = parseFloat(stored);
    if (isNaN(s.value)) s.value = def;
    this.settings.push(s);
    return s;
  }
  /** A relay or other on/off output on a GPIO. */
  relay(name: string, pin: i32, activeLow: bool = false): Output {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, activeLow ? 1 : 0);
    const o = new Output(this, name, pin, activeLow);
    outputFailsafe(pin, activeLow ? 1 : 0);
    this.outputs.push(o);
    return o;
  }
  output(name: string, pin: i32, activeLow: bool = false): Output { return this.relay(name, pin, activeLow); }
  /** A digital input. Fires the events "<name>.on" and "<name>.off" (debounced). */
  input(name: string, pin: i32, activeLow: bool = true, debounceMs: i32 = 30, pullup: bool = true): Input {
    pinMode(pin, pullup ? INPUT_PULLUP : INPUT);
    attachInterrupt(pin, 3);
    const i = new Input(this, name, pin, activeLow, debounceMs);
    this.inputs.push(i);
    return i;
  }
  /** A push button to GND (active low, pulled up). Fires "<name>.on" when pressed. */
  button(name: string, pin: i32): Input { return this.input(name, pin, true, 30, true); }
  /** A relay on an I2C expander bit (KinCony relays are active low). "at" labels it, e.g. "R3". */
  relayAt(name: string, expander: Pcf8574, bit: i32, activeLow: bool = true, at: string = ""): Output {
    const o = new Output(this, name, -1, activeLow);
    o.expander = expander;
    o.bit = bit;
    o.at = at.length ? at : expander.pinName(bit);
    expander.writeBit(bit, activeLow ? 1 : 0);
    expander.setFailsafe(bit, activeLow ? 1 : 0);
    this.outputs.push(o);
    return o;
  }
  /** A digital input on an I2C expander bit (polled every 50 ms). Events "<name>.on" / ".off". */
  inputAt(name: string, expander: Pcf8574, bit: i32, activeLow: bool = true, debounceMs: i32 = 50, at: string = ""): Input {
    const i = new Input(this, name, -1, activeLow, debounceMs);
    i.expander = expander;
    i.bit = bit;
    i.at = at.length ? at : expander.pinName(bit);
    this.inputs.push(i);
    return i;
  }
  /** A command apps and websites can send: {"t":"cmd","n":name,"v":...}. */
  command(name: string, handler: (args: Args) => void): Command {
    const c = new Command(name, handler);
    this.commands.push(c);
    return c;
  }
  /**
   * The name people see for a value, setting, output, input, command, machine or state, e.g.
   * app.label("heating", "Aquecendo"). Code keeps the short name; dashboards show the label.
   */
  label(name: string, text: string): void {
    const i = this.labelKeys.indexOf(name);
    if (i >= 0) this.labelTexts[i] = text;
    else { this.labelKeys.push(name); this.labelTexts.push(text); }
  }
  /** Declares an event name (for the manifest; emit() works without it). */
  event(name: string): void { this.events.push(name); }
  /** A state machine with these states; the first is the initial state. */
  machine(name: string, states: string[]): Machine {
    const m = new Machine(this, name, states);
    this.machines.push(m);
    return m;
  }

  // -- behaviour --

  every(ms: i32, fn: () => void): void { this.timers.push(new Timer(fn, ms, millis() + ms, true)); }
  after(ms: i32, fn: () => void): void { this.timers.push(new Timer(fn, ms, millis() + ms, false)); }
  /** Daily at "HH:MM" local time (see timezone()); needs the clock from ESP Lab. */
  at(hhmm: string, fn: () => void): void {
    const h = <i32>parseInt(hhmm.substring(0, 2));
    const m = <i32>parseInt(hhmm.substring(3, 5));
    this.schedules.push(new Schedule(h * 60 + m, fn, hhmm));
  }
  /** Minutes east of UTC for at() schedules, e.g. -180 for UTC-3. */
  timezone(offsetMin: i32): void { this.utcOffsetMin = offsetMin; }
  /** Runs fn when an event happens: input events ("door.on"), emitted events, "online", "offline", "config", "boot". */
  on(event: string, fn: () => void): void { this.hooks.push(new Hook(event, fn)); }
  /** Raises an event: machines and on() hooks react, and ESP Lab / apps receive it. */
  emit(event: string): void { this.sendEvent(event, "null"); this.dispatch(event); }
  emitValue(event: string, v: f64): void { this.sendEvent(event, jsonNumber(v)); this.dispatch(event); }
  emitText(event: string, text: string): void { this.sendEvent(event, jsonString(text)); this.dispatch(event); }
  /** Prints a log line (serial and ESP Lab's log). */
  log(text: string): void { print(text + "\n"); }

  dispatch(event: string): void {
    for (let i = 0; i < this.hooks.length; i++) if (this.hooks[i].name == event) this.hooks[i].fn();
    for (let i = 0; i < this.machines.length; i++) this.machines[i].dispatch(event);
  }

  sendEvent(name: string, valueJson: string): void {
    this.seq++;
    w.begin().raw('{"t":"evt"').key("n").str(name).key("v").raw(valueJson).key("seq").int(this.seq).ch(125).send();
  }

  // -- protocol --

  writeManifest(): void {
    w.ch(123).key("app", true).str(this.name).key("ver").str(this.version).key("sensors").ch(91);
    for (let i = 0; i < this.sensors.length; i++) {
      const x = this.sensors[i];
      if (i) w.ch(44);
      w.ch(123).key("n", true).str(x.name).key("u").str(x.unit).ch(125);
    }
    w.ch(93).key("settings").ch(91);
    for (let i = 0; i < this.settings.length; i++) {
      const x = this.settings[i];
      if (i) w.ch(44);
      w.ch(123).key("n", true).str(x.name).key("u").str(x.unit).key("d").num(x.def).key("min").num(x.min).key("max").num(x.max).ch(125);
    }
    w.ch(93).key("outputs").ch(91);
    for (let i = 0; i < this.outputs.length; i++) {
      const x = this.outputs[i];
      if (i) w.ch(44);
      w.ch(123).key("n", true).str(x.name).key("pin").int(x.pin);
      if (x.at.length) w.key("at").str(x.at);
      const req = x.requires;
      if (req != null) w.key("requires").str(req.name);
      if (x.minOnMs) w.key("minOnMs").int(x.minOnMs);
      if (x.minOffMs) w.key("minOffMs").int(x.minOffMs);
      w.ch(125);
    }
    w.ch(93).key("inputs").ch(91);
    for (let i = 0; i < this.inputs.length; i++) {
      const x = this.inputs[i];
      if (i) w.ch(44);
      w.ch(123).key("n", true).str(x.name).key("pin").int(x.pin);
      if (x.at.length) w.key("at").str(x.at);
      w.ch(125);
    }
    w.ch(93).key("commands").ch(91);
    for (let i = 0; i < this.commands.length; i++) { if (i) w.ch(44); w.str(this.commands[i].name); }
    w.ch(93).key("events").ch(91);
    for (let i = 0; i < this.events.length; i++) { if (i) w.ch(44); w.str(this.events[i]); }
    w.ch(93).key("machines").ch(91);
    for (let i = 0; i < this.machines.length; i++) { if (i) w.ch(44); this.machines[i].writeManifest(); }
    w.ch(93).key("schedules").ch(91);
    for (let i = 0; i < this.schedules.length; i++) { if (i) w.ch(44); w.str(this.schedules[i].label); }
    w.ch(93);
    if (this.labelKeys.length) {
      w.key("labels").ch(123);
      for (let i = 0; i < this.labelKeys.length; i++) w.key(this.labelKeys[i], i == 0).str(this.labelTexts[i]);
      w.ch(125);
    }
    w.ch(125);
  }

  hello(): void {
    const n = deviceIdRaw(buffer.dataStart, BUF_SIZE);
    w.begin().raw('{"t":"hello","proto":1').key("id").ch(34);
    for (let i = 0; i < n; i++) w.ch(buffer[i]);
    w.ch(34).key("cfgVer").int(this.cfgVersion).key("clock").int(this.clock);
    // Settings changed locally while offline: the hub takes them before pushing its own.
    if (this.localCfg.length) w.key("pendingCfg").raw("true");
    w.key("m");
    this.writeManifest();
    w.ch(125).send();
    for (let i = 0; i < this.sensors.length; i++) this.sensors[i].dirty = true;
    for (let i = 0; i < this.settings.length; i++) this.settings[i].dirty = true;
    for (let i = 0; i < this.outputs.length; i++) this.outputs[i].dirty = true;
    for (let i = 0; i < this.inputs.length; i++) this.inputs[i].dirty = true;
    for (let i = 0; i < this.machines.length; i++) this.machines[i].dirty = true;
    this.report();
    this.sendLocalCfg();
  }

  /** Reports settings changed on the local page: {"t":"cfglocal","v":{...}} (the hub merges them). */
  sendLocalCfg(): void {
    if (!this.localCfg.length) return;
    w.begin().raw('{"t":"cfglocal","v":{');
    let first = true;
    for (let i = 0; i < this.settings.length; i++) {
      const x = this.settings[i];
      if (!this.localCfg.includes(x.name)) continue;
      w.key(x.name, first).num(x.value);
      first = false;
    }
    w.raw("}}").send();
  }

  report(): void {
    w.begin().raw('{"t":"state","v":{');
    let first = true;
    for (let i = 0; i < this.sensors.length; i++) {
      const x = this.sensors[i];
      if (!x.dirty) continue;
      x.dirty = false;
      x.reported = x.value;
      w.key(x.name, first).num(x.value);
      first = false;
    }
    for (let i = 0; i < this.settings.length; i++) {
      const x = this.settings[i];
      if (!x.dirty) continue;
      x.dirty = false;
      w.key(x.name, first).num(x.value);
      first = false;
    }
    for (let i = 0; i < this.outputs.length; i++) {
      const x = this.outputs[i];
      if (!x.dirty) continue;
      x.dirty = false;
      w.key(x.name, first).bool(x.isOn);
      first = false;
    }
    for (let i = 0; i < this.inputs.length; i++) {
      const x = this.inputs[i];
      if (!x.dirty) continue;
      x.dirty = false;
      w.key(x.name, first).bool(x.value);
      first = false;
    }
    for (let i = 0; i < this.machines.length; i++) {
      const x = this.machines[i];
      if (!x.dirty) continue;
      x.dirty = false;
      w.key(x.name, first).str(x.state);
      first = false;
    }
    if (!first) w.raw("}}").send();
  }

  handleMessage(text: string): void {
    // Only frames a device acts on are parsed (a full parse costs memory): peek at "t" first.
    const kind = frameType(text);
    if (kind == "sub") {
      const h = subHandler;
      if (h != null) h(text);
      return;
    }
    if (kind != "cmd" && kind != "cfg" && kind != "time" && kind != "sync" && kind != "evt") return;
    if (text.length > 1500) { print("[lab] message too large, ignored\n"); return; }
    __collect();
    const msg = parseJson(text);
    if (msg.kind != 4) return;
    const t = msg.str("t");
    if (t == "cmd") {
      const name = msg.str("n");
      const id = msg.get("id");
      const v = msg.get("v");
      const args = new Args(v != null ? v : new Json());
      let found = false;
      for (let i = 0; i < this.commands.length; i++) {
        if (this.commands[i].name == name) {
          found = true;
          this.commands[i].handler(args);
          break;
        }
      }
      if (!found) args.fail("unknown command " + name);
      w.begin().raw('{"t":"ack"').key("id");
      if (id == null) w.raw("null"); else if (id.kind == 3) w.str(id.s); else w.num(id.n);
      w.key("ok").bool(args.error.length == 0);
      if (args.error.length) w.key("err").str(args.error); else w.key("v").raw(args.result);
      w.ch(125).send();
      this.changed = true;
    } else if (t == "cfg") {
      const v = msg.get("v");
      const local = msg.get("local") != null;
      if (v != null && v.kind == 4) {
        for (let k = 0; k < v.keys.length; k++) {
          for (let i = 0; i < this.settings.length; i++) {
            if (this.settings[i].name == v.keys[k] && v.items[k].isNumber) {
              this.settings[i].set(v.items[k].number);
              if (local && !this.localCfg.includes(v.keys[k])) this.localCfg.push(v.keys[k]);
            }
          }
        }
      }
      if (local) {
        // From the local page: kept until the hub confirms it (it may be offline for days).
        saveText("cfglocal", this.localCfg.join(","));
        this.sendLocalCfg();
        this.dispatch("config");
        return;
      }
      if (this.localCfg.length) { this.localCfg = []; saveText("cfglocal", ""); }
      const ver = <i32>msg.num("ver", 0);
      if (ver > 0) { this.cfgVersion = ver; saveText("cfgver", ver.toString()); }
      w.begin().raw('{"t":"cfgack"').key("ver").int(this.cfgVersion).ch(125).send();
      this.dispatch("config");
    } else if (t == "time") {
      setEpochMs(<i64>msg.num("ms", 0));
    } else if (t == "sync") {
      this.hello();
    } else if (t == "evt") {
      // Events from other devices or apps feed the machines and hooks.
      this.dispatch(msg.str("n"));
    }
  }

  // -- the event loop (called by the firmware through __lab_run) --

  run(): void {
    const cv = loadText("cfgver");
    if (cv != null) this.cfgVersion = <i32>parseInt(cv);
    const lc = loadText("cfglocal");
    if (lc != null && lc.length) this.localCfg = lc.split(",");
    const now0 = millis();
    for (let i = 0; i < this.sensors.length; i++) this.sensors[i].nextAt = now0;
    for (let i = 0; i < this.inputs.length; i++) {
      const x = this.inputs[i];
      const xp = x.expander;
      x.raw = ((xp != null ? xp.readBit(x.bit) : digitalRead(x.pin)) == 1) != x.activeLow;
      x.value = x.raw;
    }
    for (let i = 0; i < this.machines.length; i++) this.machines[i].start();
    this.hello();
    this.dispatch("boot");

    while (true) {
      let now = millis();
      // When to wake up next.
      let next: i64 = this.lastTick + this.tickMs;
      for (let i = 0; i < this.timers.length; i++) if (this.timers[i].nextAt < next) next = this.timers[i].nextAt;
      for (let i = 0; i < this.sensors.length; i++) {
        const s = this.sensors[i];
        if (s.everyMs > 0 && s.nextAt < next) next = s.nextAt;
      }
      for (let i = 0; i < this.machines.length; i++) {
        const t = this.machines[i].nextTimeout();
        if (t < next) next = t;
      }
      for (let i = 0; i < this.outputs.length; i++) {
        const t = this.outputs[i].pendingAt();
        if (t < next) next = t;
      }
      if (this.inputs.length && now + 50 < next) next = now + 50; // debounce and polling fallback
      if (pinWatchFns.length && now + 1000 < next) next = now + 1000;
      if (this.changed) next = now;
      const wait = next > now ? <i32>Math.min(<f64>(next - now), 60000) : 0;

      const r = waitEventRaw(wait, buffer.dataStart, BUF_SIZE);
      if (r < 0) return; // a new program is being installed
      if (r > 0) {
        const kind = r >>> 24;
        const len = r & 0xffffff;
        if (kind == EV_MESSAGE) this.handleMessage(String.UTF8.decodeUnsafe(buffer.dataStart, len));
        else if (kind == EV_NET && len >= 2) {
          if (len >= 3) this.clock = <i32>buffer[2];
          const up = buffer[1] != 0;
          if (up != this.online) {
            this.online = up;
            if (up) this.hello();
            this.dispatch(up ? "online" : "offline");
          }
        }
        // EV_GPIO: inputs are sampled below.
      }
      for (let i = 0; i < pinWatchFns.length; i++) pinWatchFns[i]();

      now = millis();
      for (let i = 0; i < this.inputs.length; i++) this.inputs[i].sample(now);
      for (let i = 0; i < this.sensors.length; i++) {
        const s = this.sensors[i];
        if (s.everyMs > 0 && now >= s.nextAt) {
          s.nextAt = now + s.everyMs;
          s.set(s.read());
        }
      }
      for (let i = 0; i < this.timers.length; i++) {
        const t = this.timers[i];
        if (now >= t.nextAt) {
          t.fn();
          if (t.repeat) t.nextAt = now + t.periodMs;
          else { this.timers.splice(i, 1); i--; }
        }
      }
      this.runSchedules();
      for (let i = 0; i < this.machines.length; i++) this.machines[i].checkTimeout(now);
      if (this.changed || now - this.lastTick >= this.tickMs) {
        this.changed = false;
        this.lastTick = now;
        // "tick": conditions are re-checked; a few rounds let chained transitions settle.
        for (let round = 0; round < 4; round++) {
          let moved = false;
          for (let i = 0; i < this.machines.length; i++) {
            const m = this.machines[i];
            m.durings[m.current]();
            if (m.dispatch("tick")) moved = true;
          }
          if (!moved) break;
        }
        for (let i = 0; i < this.hooks.length; i++) if (this.hooks[i].name == "tick") this.hooks[i].fn();
      }
      for (let i = 0; i < this.outputs.length; i++) this.outputs[i].apply(now);
      // Second pass: outputs that depend on others switched in the first pass.
      for (let i = 0; i < this.outputs.length; i++) this.outputs[i].apply(now);
      this.report();
      // Programs get one 64 KiB page: free this round's garbage (JSON text) before the next.
      __collect();
    }
  }

  runSchedules(): void {
    if (!this.schedules.length) return;
    const epoch = epochMsRaw();
    if (epoch == 0) return;
    const local = epoch / 1000 + <i64>this.utcOffsetMin * 60;
    const day = local / 86400;
    const minute = <i32>((local % 86400) / 60);
    for (let i = 0; i < this.schedules.length; i++) {
      const s = this.schedules[i];
      if (s.minuteOfDay == minute && s.lastDay != day) {
        s.lastDay = day;
        s.fn();
      }
    }
  }
}

function nanRead(): f64 { return NaN; }

/** Entry point the firmware calls for "lab" programs. */
export function __lab_run(): void {
  const app = theApp;
  if (app != null) app.run();
  else print("[lab] no App was created\n");
}

// ---- control helpers -----------------------------------------------------------------------

/** On/off control with a dead band: on below "low", off above "high" (heating). */
export class Hysteresis {
  on: bool = false;
  constructor(public low: f64, public high: f64) {}
  update(v: f64): bool {
    if (v <= this.low) this.on = true;
    else if (v >= this.high) this.on = false;
    return this.on;
  }
}

/** A PID controller with output limits and anti-windup. */
export class Pid {
  integral: f64 = 0;
  last: f64 = NaN;
  constructor(public kp: f64, public ki: f64, public kd: f64, public outMin: f64 = 0, public outMax: f64 = 100) {}
  update(setpoint: f64, measured: f64, dtSeconds: f64): f64 {
    const err = setpoint - measured;
    const deriv = isNaN(this.last) ? 0 : (measured - this.last) / dtSeconds;
    this.last = measured;
    const trial = this.integral + err * dtSeconds;
    let out = this.kp * err + this.ki * trial - this.kd * deriv;
    if (out > this.outMax) out = this.outMax;
    else if (out < this.outMin) out = this.outMin;
    else this.integral = trial;
    return out;
  }
}

/** Linear map: scale(raw, 0, 4095, 0, 100). */
export function scale(v: f64, inMin: f64, inMax: f64, outMin: f64, outMax: f64): f64 {
  return outMin + ((v - inMin) * (outMax - outMin)) / (inMax - inMin);
}

/** NTC thermistor on an ADC pin (to GND, series resistor to 3V3): degrees Celsius. */
export function ntcCelsius(raw: f64, beta: f64 = 3950, r0: f64 = 10000, rSeries: f64 = 10000, t0: f64 = 25): f64 {
  if (raw <= 0 || raw >= 4095) return NaN;
  const r = (rSeries * raw) / (4095 - raw);
  const k = 1 / (1 / (t0 + 273.15) + Math.log(r / r0) / beta);
  return k - 273.15;
}
`;
