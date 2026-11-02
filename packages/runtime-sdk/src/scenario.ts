/**
 * Scenario tests for ESP Lab programs: tests.json in a project describes situations (sensor
 * temperatures, inputs, commands, settings) at simulated times and what the device must do
 * (states, relays, values, events). The real compiled program runs against simulated hardware
 * at simulated speed, so an hour of operation takes about a second. Used by the AI (it must make
 * the tests pass before it says a device is done), by the IDE's Test button and by CI.
 *
 *   {
 *     "tests": [{
 *       "name": "spa heats with flow",
 *       "steps": [
 *         { "at": 0, "set": { "ds18b20:32": 25, "in:1": true } },
 *         { "at": 1, "command": "spa" },
 *         { "at": 300, "expect": { "mode": "spa", "relay:3": true, "waterTemp": { "min": 24 } } }
 *       ]
 *     }]
 *   }
 *
 * Hardware keys ("set"):
 *   gpio:N        digital input level (true/false or 1/0)
 *   adc:N         raw ADC count 0-4095            volts:N   volts on a GPIO ADC pin (0-3.3)
 *   ai:N          KC868-A6 analog input N (1-4), volts 0-5
 *   ntc:N         KC868-A6 analog input N with an NTC 10k (B 3435) in a 5 V / 10k divider, in °C
 *                 (ntc3950:N for B 3950); null = open sensor
 *   ds18b20:PIN   a DS18B20 on that 1-Wire pin, in °C; null = no probe
 *   thermistor:PIN  a 10k NTC (B 3950) from 3V3 to that ADC pin with 10k to GND, in °C; counts
 *                 follow the chip's ADC curve (options.chip); null = open sensor
 *   in:N          KC868-A6 input N closed (true) or open
 *   pcf:ADDR:BIT  a PCF8574 / PCF8575 pin level held by the circuit (ADDR like 0x22; BIT 0-15,
 *                 8-15 = P10-P17 of a PCF8575); true = high (released), false = pulled to GND
 *   ads1115:ADDR:CH  volts on input CH (0-3) of an ADS1115 at ADDR (0x48-0x4B); unset inputs read 0 V
 *   modbus:U:R    holding and input register R of Modbus unit U (on the serial port)
 * Expectations ("expect"): any reported value, setting, output, input or machine name; relay:N
 * (KC868-A6 relay on); gpio:N (output level); pcf:ADDR:BIT (expander output latch: true = high,
 * false = driven low); event:NAME (emitted at least once so far);
 * modbus:U:R (register written by the program). Numbers match within 0.05, or give
 * { "min": a, "max": b }; { "not": x } matches anything but x.
 */
import { adcRaw, type AdcChip } from './adc';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ScenarioStep {
  /** Seconds from the start. */
  at: number;
  set?: Record<string, number | boolean | null>;
  command?: string;
  value?: Json;
  config?: Record<string, number>;
  event?: string;
  expect?: Record<string, Json>;
}

export interface Scenario {
  name: string;
  steps: ScenarioStep[];
}

export interface ScenarioFile {
  tests: Scenario[];
}

export interface ScenarioFailure {
  at: number;
  key: string;
  expected: Json;
  actual: Json;
}

export interface ScenarioResult {
  name: string;
  ok: boolean;
  failures: ScenarioFailure[];
  /** Reported state at the end. */
  state: Record<string, Json>;
  /** Events the program emitted (names, in order). */
  events: string[];
  /** Console output (the program's prints and the framework's messages). */
  log: string;
  error?: string;
  simulatedSeconds: number;
  wallMs: number;
}

/**
 * Compiler flags for a test build: the program's top-level code then runs when the runner calls
 * it, after the simulator can see the program's memory (pass them to compileProgram).
 */
export const SCENARIO_COMPILE_FLAGS = ['--exportStart', '_start'];

/** Bump when the runner changes, so browsers load the new one. */
export const SCENARIO_RUNNER_VERSION = '1';

/** Parses tests.json; throws with a readable message. */
export function parseScenarioFile(text: string): ScenarioFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`tests.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const tests = Array.isArray(data) ? data : (data as { tests?: unknown })?.tests;
  if (!Array.isArray(tests) || tests.length === 0) throw new Error('tests.json needs {"tests": [{"name", "steps": [...]}]}.');
  for (const t of tests as Scenario[]) {
    if (!t || typeof t.name !== 'string' || !Array.isArray(t.steps)) throw new Error('Each test needs a "name" and "steps".');
    for (const s of t.steps) if (typeof s?.at !== 'number' || s.at < 0) throw new Error(`Test "${t.name}": every step needs "at" (seconds, >= 0).`);
  }
  return { tests: tests as Scenario[] };
}

const KC868_AI = [36, 39, 34, 35];

/** Runs every scenario of the file against the compiled program. */
export interface ScenarioOptions {
  deviceId?: string;
  maxSeconds?: number;
  /** The board's chip: the ADC curve thermistor readings follow (default the classic ESP32). */
  chip?: AdcChip;
}

export async function runScenarios(wasm: Uint8Array, file: ScenarioFile, options: ScenarioOptions = {}): Promise<ScenarioResult[]> {
  const module = await WebAssembly.compile(wasm as BufferSource);
  const results: ScenarioResult[] = [];
  for (const scenario of file.tests) results.push(await runOne(module, scenario, options));
  return results;
}

async function runOne(module: WebAssembly.Module, scenario: Scenario, options: ScenarioOptions): Promise<ScenarioResult> {
  const started = Date.now();
  const sim = new SimBoard(options.deviceId ?? 'esp32-246f28001122', options.chip ?? 'esp32');
  const steps = [...scenario.steps].sort((a, b) => a.at - b.at);
  const limit = Math.min(options.maxSeconds ?? 24 * 3600, 7 * 24 * 3600) * 1000;
  const failures: ScenarioFailure[] = [];
  let next = 0;
  // Steps at time 0 that set hardware apply before the program starts (sensors read at boot).
  while (next < steps.length && steps[next].at === 0 && !steps[next].expect && !steps[next].command && !steps[next].config && !steps[next].event) {
    sim.apply(steps[next].set ?? {});
    next++;
  }
  const doStep = (step: ScenarioStep) => {
    if (step.set) sim.apply(step.set);
    if (step.config) sim.queue({ t: 'cfg', ver: ++sim.cfgVer, v: step.config });
    if (step.command) sim.queue({ t: 'cmd', id: `test-${sim.queued}`, n: step.command, ...(step.value !== undefined ? { v: step.value } : {}) });
    if (step.event) sim.queue({ t: 'evt', n: step.event });
    if (step.expect) {
      for (const [key, expected] of Object.entries(step.expect)) {
        const actual = sim.read(key);
        if (!matches(expected, actual)) failures.push({ at: step.at, key, expected, actual });
      }
    }
  };
  sim.onWait = (timeoutMs) => {
    // Wake for the next step if it comes before the program's own timeout.
    while (next < steps.length && steps[next].at * 1000 <= sim.now) doStep(steps[next++]);
    const message = sim.dequeue();
    if (message) return message;
    if (next >= steps.length) return 'stop';
    const until = steps[next].at * 1000;
    if (until > limit) return 'stop';
    sim.now = Math.min(sim.now + Math.max(timeoutMs, 0), until);
    return null;
  };
  let error: string | undefined;
  try {
    await sim.run(module);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  // Steps the program never waited for (it stopped early): check them anyway.
  while (next < steps.length && !error) doStep(steps[next++]);
  return {
    name: scenario.name,
    ok: !error && failures.length === 0,
    failures,
    state: sim.state(),
    events: sim.events(),
    log: sim.log.slice(-4000),
    ...(error ? { error } : {}),
    simulatedSeconds: Math.round(sim.now / 1000),
    wallMs: Date.now() - started,
  };
}

function matches(expected: Json, actual: Json): boolean {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    const e = expected as Record<string, Json>;
    if ('not' in e) return !matches(e.not, actual);
    if ('min' in e || 'max' in e) {
      if (typeof actual !== 'number') return false;
      return (e.min === undefined || actual >= Number(e.min)) && (e.max === undefined || actual <= Number(e.max));
    }
  }
  if (typeof expected === 'number' && typeof actual === 'number') return Math.abs(expected - actual) <= 0.05;
  return expected === actual;
}

// ---- the simulated board --------------------------------------------------------------------

type Message = Record<string, Json>;

class SimBoard {
  now = 0;
  log = '';
  cfgVer = 0;
  queued = 0;
  onWait: (timeoutMs: number) => Message | 'stop' | null = () => 'stop';
  private memory: WebAssembly.Memory | null = null;
  private sent: string[] = [];
  private partial = '';
  private messages: Message[] = [];
  private zeroWaits = 0;
  private din = new Map<number, number>();
  private dout = new Map<number, number>();
  private adc = new Map<number, number>();
  private oneWire = new Map<number, OneWireBus>();
  private pcf = new Map<number, Pcf8574>();
  private ads = new Map<number, Ads1115>();
  private modbus = new ModbusBus();

  constructor(private id: string, private chip: AdcChip = 'esp32') {}

  queue(message: Message): void { this.messages.push(message); this.queued++; }
  dequeue(): Message | null { return this.messages.shift() ?? null; }

  apply(values: Record<string, number | boolean | null>): void {
    for (const [key, raw] of Object.entries(values)) {
      const [kind, a, b] = key.split(':');
      const value = raw === null ? null : typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(raw);
      const n = Number(a);
      switch (kind) {
        case 'gpio': this.din.set(n, value ? 1 : 0); break;
        case 'adc': this.adc.set(n, Math.round(value ?? 0)); break;
        case 'volts': this.adc.set(n, Math.round(((value ?? 0) / 3.3) * 4095)); break;
        case 'ai': this.adc.set(KC868_AI[n - 1] ?? n, Math.round(((value ?? 0) / 5) * 4095)); break;
        case 'ntc':
        case 'ntc3950': {
          const beta = kind === 'ntc' ? 3435 : 3950;
          let count = 0;
          if (value !== null) {
            const r = 10000 * Math.exp(beta * (1 / (value + 273.15) - 1 / 298.15));
            count = Math.round(((10000 / (r + 10000)) * 5 / 5) * 4095);
          }
          this.adc.set(KC868_AI[n - 1] ?? n, count);
          break;
        }
        case 'thermistor': {
          let mv = 0;
          if (value !== null) {
            const r = 10000 * Math.exp(3950 * (1 / (value + 273.15) - 1 / 298.15));
            mv = (3300 * 10000) / (r + 10000);
          }
          this.adc.set(n, mv <= 0 ? 0 : adcRaw(mv, this.chip));
          break;
        }
        case 'ds18b20': {
          if (value === null) this.oneWire.delete(n);
          else {
            const bus = this.oneWire.get(n) ?? new OneWireBus(n);
            bus.celsius = value;
            this.oneWire.set(n, bus);
          }
          break;
        }
        case 'in': this.expander(0x22).setPin(n - 1, value ? 0 : 1); break;
        case 'pcf': this.expander(Number(a)).setPin(Number(b), value ? 1 : 0); break;
        case 'ads1115': {
          if (!isAdsAddress(Number(a)) || !(Number(b) >= 0 && Number(b) <= 3)) throw new Error(`"${key}": ADS1115 addresses are 0x48-0x4B, inputs 0-3.`);
          this.adc1115(Number(a)).volts[Number(b)] = value ?? 0;
          break;
        }
        case 'modbus': this.modbus.set(n, Number(b), value ?? 0); break;
        default: throw new Error(`Unknown hardware key "${key}" in a test step.`);
      }
    }
  }

  read(key: string): Json {
    const [kind, a, b] = key.split(':');
    if (kind === 'relay' && a !== undefined) return ((this.expander(0x24).latch >> (Number(a) - 1)) & 1) === 0;
    if (kind === 'gpio' && a !== undefined) return (this.dout.get(Number(a)) ?? 0) === 1;
    if (kind === 'pcf' && b !== undefined) return ((this.expander(Number(a)).latch >> Number(b)) & 1) === 1;
    if (kind === 'event' && a !== undefined) return this.events().includes(key.slice(6));
    if (kind === 'modbus' && b !== undefined) return this.modbus.get(Number(a), Number(b));
    const state = this.state();
    return key in state ? state[key] : null;
  }

  state(): Record<string, Json> {
    let state: Record<string, Json> = {};
    for (const f of this.frames()) if (f.t === 'state' && f.v && typeof f.v === 'object') state = { ...state, ...(f.v as Record<string, Json>) };
    return state;
  }

  events(): string[] {
    return this.frames().filter((f) => f.t === 'evt').map((f) => String(f.n));
  }

  private frames(): Message[] {
    const out: Message[] = [];
    for (const s of this.sent) {
      try {
        out.push(JSON.parse(s) as Message);
      } catch {
        /* not JSON */
      }
    }
    return out;
  }

  private adc1115(address: number): Ads1115 {
    let x = this.ads.get(address);
    if (!x) this.ads.set(address, (x = new Ads1115()));
    return x;
  }

  private expander(address: number): Pcf8574 {
    let x = this.pcf.get(address);
    if (!x) this.pcf.set(address, (x = new Pcf8574()));
    return x;
  }

  private mem(): Uint8Array { return new Uint8Array(this.memory!.buffer); }
  private str16(ptr: number, bytes: number): string {
    const view = new Uint16Array(this.memory!.buffer, ptr, bytes >> 1);
    let s = '';
    for (let i = 0; i < view.length; i += 4096) s += String.fromCharCode(...view.subarray(i, i + 4096));
    return s;
  }

  async run(module: WebAssembly.Module): Promise<void> {
    const instance = await WebAssembly.instantiate(module, this.imports());
    this.memory = instance.exports.memory as WebAssembly.Memory;
    const exports = instance.exports as Record<string, () => void>;
    if (!exports._start) throw new Error('Compile the program with SCENARIO_COMPILE_FLAGS for scenario tests.');
    exports._start();
    if (exports.__lab_run) exports.__lab_run();
    else throw new Error('Scenario tests need a "lab" program (import { App } from "lab").');
  }

  private imports(): WebAssembly.Imports {
    const b = this;
    const encoder = new TextEncoder();
    const esp = {
      waitEvent(timeout: number, buf: number, cap: number): number {
        const r = b.onWait(timeout);
        if (r === 'stop') return -1;
        if (r === null) {
          b.zeroWaits = timeout <= 0 ? b.zeroWaits + 1 : 0;
          if (b.zeroWaits > 20000) throw new Error(`busy loop: the program stopped waiting at ${Math.round(b.now / 1000)} s`);
          return 0;
        }
        b.zeroWaits = 0;
        b.now += 5;
        const data = encoder.encode(JSON.stringify(r));
        if (data.length > cap) return 0;
        b.mem().set(data, buf);
        return (2 << 24) | data.length;
      },
      attachInterrupt() {},
      send(ptr: number, bytes: number) {
        const text = b.str16(ptr, bytes);
        const marker = text.charCodeAt(0);
        if (marker === 1 || marker === 2) {
          b.partial += text.slice(1);
          if (marker === 2) { b.sent.push(b.partial); b.partial = ''; }
          return;
        }
        b.partial = '';
        b.sent.push(text);
      },
      kvGet: () => -1,
      kvSet: () => 0,
      epochMs: () => BigInt(1793544000000 + Math.round(b.now)),
      setEpochMs() {},
      outputFailsafe() {},
      deviceId(out: number) { const id = encoder.encode(b.id); b.mem().set(id, out); return id.length; },
      pinMode() {},
      digitalWrite(pin: number, v: number) { b.dout.set(pin, v ? 1 : 0); },
      digitalRead: (pin: number) => b.din.get(pin) ?? 1,
      analogRead: (pin: number) => b.adc.get(pin) ?? 0,
      analogWrite() {},
      delay(ms: number) { b.now += Math.max(ms, 0); },
      delayMicroseconds() {},
      millis: () => BigInt(Math.round(b.now)),
      micros: () => BigInt(Math.round(b.now * 1000)),
      random: (max: number) => Math.floor(Math.random() * max),
      print(ptr: number, bytes: number) { b.log += b.str16(ptr, bytes); if (b.log.length > 20000) b.log = b.log.slice(-10000); },
      i2cBegin: () => 0,
      i2cWrite(addr: number, ptr: number, len: number) {
        const data = b.mem().slice(ptr, ptr + len);
        if (isAdsAddress(addr)) { b.adc1115(addr).write(data); return 0; }
        if (!isPcfAddress(addr)) return -1;
        b.expander(addr).write(data);
        return 0;
      },
      i2cRead(addr: number, ptr: number, len: number) {
        if (isAdsAddress(addr)) { b.mem().set(b.adc1115(addr).read(len), ptr); return 0; }
        if (!isPcfAddress(addr)) return -1;
        b.mem().set(b.expander(addr).read(len), ptr);
        return 0;
      },
      i2cFailsafe() {},
      uartOpen: () => 0,
      uartWrite(port: number, ptr: number, len: number) { b.modbus.write(b.mem().slice(ptr, ptr + len)); return len; },
      uartRead(port: number, ptr: number, cap: number, timeout: number) {
        const got = b.modbus.read(cap);
        if (!got.length) { b.now += Math.max(timeout, 0); return 0; }
        b.mem().set(got, ptr);
        return got.length;
      },
      uartAvailable: () => b.modbus.pending(),
      spiBegin: () => 0,
      spiDevice: () => 0,
      spiTransfer: () => 0, // no radio attached: reads come back as zeros
      owReset: (pin: number) => b.oneWire.get(pin)?.reset() ?? 0,
      owBit: (pin: number, bit: number) => b.oneWire.get(pin)?.bit(bit) ?? 1,
      owWrite(pin: number, v: number) { const bus = b.oneWire.get(pin); for (let i = 0; i < 8; i++) bus?.bit((v >> i) & 1); },
      owRead(pin: number) { const bus = b.oneWire.get(pin); let v = 0; for (let i = 0; i < 8; i++) v |= (bus?.bit(1) ?? 1) << i; return v; },
      hmacSha256(k: number, kl: number, data: number, len: number, out: number) {
        const mac = hmacSha256(b.mem().slice(k, k + kl), b.mem().slice(data, data + len));
        b.mem().set(mac, out);
        return 32;
      },
    };
    const env = {
      abort(msg: number, file: number, line: number, col: number) {
        const text = (p: number) => (p ? b.str16(p, new Uint32Array(b.memory!.buffer, p - 4, 1)[0]) : '');
        throw new Error(`abort: ${text(msg)} (${text(file)}:${line}:${col})`);
      },
      seed: () => Math.random() * 1e9,
      trace() {},
    };
    return { esp, env };
  }
}

function isPcfAddress(addr: number): boolean { return (addr >= 0x20 && addr <= 0x27) || (addr >= 0x38 && addr <= 0x3f); }

function isAdsAddress(addr: number): boolean { return addr >= 0x48 && addr <= 0x4b; }

/** A PCF8574 (one port byte per transfer) or PCF8575 (two: P0x then P1x). */
class Pcf8574 {
  latch = 0xffff;
  pins = 0xffff;
  setPin(bit: number, level: number): void { this.pins = level ? this.pins | (1 << bit) : this.pins & ~(1 << bit); }
  write(data: Uint8Array): void {
    data.forEach((byte, i) => {
      this.latch = i % 2 === 0 ? (this.latch & 0xff00) | byte : (this.latch & 0x00ff) | (byte << 8);
    });
  }
  read(length: number): Uint8Array {
    const levels = this.pins & this.latch;
    return Uint8Array.from({ length }, (_, i) => (i % 2 === 0 ? levels & 0xff : levels >> 8));
  }
}

/** An ADS1115: register pointer, config, and conversions that finish at once. */
class Ads1115 {
  volts = [0, 0, 0, 0];
  private pointer = 0;
  private config = 0x8583;
  private conversion = 0;
  write(data: Uint8Array): void {
    if (data.length === 0) return;
    this.pointer = data[0] & 3;
    if (data.length < 3 || this.pointer !== 1) return;
    const value = (data[1] << 8) | data[2];
    this.config = value & 0x7fff;
    if (value & 0x8000 || (this.config & 0x100) === 0) this.convert();
  }
  read(length: number): Uint8Array {
    if (this.pointer === 0 && (this.config & 0x100) === 0) this.convert();
    const reg = this.pointer === 0 ? this.conversion & 0xffff : this.pointer === 1 ? this.config | 0x8000 : this.pointer === 2 ? 0x8000 : 0x7fff;
    return Uint8Array.from({ length }, (_, i) => (i % 2 === 0 ? reg >> 8 : reg & 0xff));
  }
  private convert(): void {
    const v = this.volts;
    const mux = (this.config >> 12) & 7;
    const [p, n] = mux === 0 ? [v[0], v[1]] : mux === 1 ? [v[0], v[3]] : mux === 2 ? [v[1], v[3]] : mux === 3 ? [v[2], v[3]] : [v[mux - 4], 0];
    const fsr = [6.144, 4.096, 2.048, 1.024, 0.512, 0.256, 0.256, 0.256][(this.config >> 9) & 7];
    this.conversion = Math.max(-32768, Math.min(32767, Math.round(((p - n) / fsr) * 32768)));
  }
}

/** One DS18B20 on a 1-Wire pin, at the bit level (reset, ROM commands, search, scratchpad). */
class OneWireBus {
  celsius = 25;
  private rom: number[];
  private state = 'idle';
  private bits: number[] = [];
  private out: number[] = [];
  private converted = false;
  private pos = 0;
  private phase = 0;
  private active = false;
  constructor(pin: number) {
    const rom = [0x28, pin, 0x11, 0x22, 0x33, 0x44, 0x55];
    rom.push(crc8(rom));
    this.rom = rom;
  }
  reset(): number { this.state = 'rom'; this.bits = []; return 1; }
  bit(b: number): number {
    switch (this.state) {
      case 'rom':
      case 'func':
      case 'match': {
        this.bits.push(b);
        if (this.state === 'match') {
          if (this.bits.length < 64) return 1;
          this.state = 'func';
          this.bits = [];
          return 1;
        }
        if (this.bits.length < 8) return 1;
        const cmd = this.bits.reduce((v, x, k) => v | (x << k), 0);
        this.bits = [];
        if (this.state === 'rom') {
          if (cmd === 0xcc) this.state = 'func';
          else if (cmd === 0x55) this.state = 'match';
          else if (cmd === 0xf0) { this.state = 'search'; this.pos = 0; this.phase = 0; this.active = true; }
          else this.state = 'idle';
        } else if (cmd === 0x44) { this.converted = true; this.state = 'idle'; }
        else if (cmd === 0xbe) {
          const raw = Math.round((this.converted ? this.celsius : 85) * 16) & 0xffff;
          const pad = [raw & 0xff, raw >> 8, 0x4b, 0x46, 0x7f, 0xff, 0x0c, 0x10];
          pad.push(crc8(pad));
          this.out = [];
          for (const byte of pad) for (let k = 0; k < 8; k++) this.out.push((byte >> k) & 1);
          this.state = 'read';
        } else this.state = 'idle';
        return 1;
      }
      case 'read':
        return this.out.length ? this.out.shift()! : 1;
      case 'search': {
        const mine = (this.rom[this.pos >> 3] >> (this.pos & 7)) & 1;
        if (this.phase === 0) { this.phase = 1; return this.active ? mine : 1; }
        if (this.phase === 1) { this.phase = 2; return this.active ? 1 - mine : 1; }
        if (b !== mine) this.active = false;
        this.pos++;
        this.phase = 0;
        if (this.pos === 64) this.state = 'idle';
        return 1;
      }
      default:
        return 1;
    }
  }
}

function crc8(bytes: number[]): number {
  let crc = 0;
  for (let byte of bytes) {
    for (let i = 0; i < 8; i++) {
      const mix = (crc ^ byte) & 1;
      crc >>= 1;
      if (mix) crc ^= 0x8c;
      byte >>= 1;
    }
  }
  return crc;
}

/** Modbus RTU slaves on the serial port: registers set by tests, written by the program. */
class ModbusBus {
  private units = new Map<number, Map<number, number>>();
  private rx: number[] = [];
  set(unit: number, reg: number, value: number): void {
    let u = this.units.get(unit);
    if (!u) this.units.set(unit, (u = new Map()));
    u.set(reg, Math.round(value) & 0xffff);
  }
  get(unit: number, reg: number): number | null { return this.units.get(unit)?.get(reg) ?? null; }
  pending(): number { return this.rx.length; }
  read(max: number): Uint8Array { return Uint8Array.from(this.rx.splice(0, max)); }
  write(bytes: Uint8Array): void {
    const f = [...bytes];
    if (f.length < 8) return;
    const unit = f[0];
    const u = this.units.get(unit);
    if (!u) return; // nobody at that address: no reply
    const crc = crc16(f.slice(0, -2));
    if ((crc & 0xff) !== f[f.length - 2] || crc >> 8 !== f[f.length - 1]) return;
    const fn = f[1];
    const a = (f[2] << 8) | f[3];
    const b = (f[4] << 8) | f[5];
    let reply: number[];
    if (fn === 3 || fn === 4) {
      reply = [unit, fn, b * 2];
      for (let i = 0; i < b; i++) { const v = u.get(a + i) ?? 0; reply.push(v >> 8, v & 0xff); }
    } else if (fn === 6) { u.set(a, b); reply = f.slice(0, 6); }
    else if (fn === 16) { for (let i = 0; i < b; i++) u.set(a + i, (f[7 + i * 2] << 8) | f[8 + i * 2]); reply = f.slice(0, 6); }
    else if (fn === 5) { u.set(a, b === 0xff00 ? 1 : 0); reply = f.slice(0, 6); }
    else reply = [unit, fn | 0x80, 1];
    const c = crc16(reply);
    reply.push(c & 0xff, c >> 8);
    this.rx.push(...reply);
  }
}

function crc16(bytes: number[]): number {
  let crc = 0xffff;
  for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1; }
  return crc;
}

// ---- SHA-256 / HMAC (synchronous, for the LoRa link's signatures) ------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const length = data.length;
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, length * 8);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  let k = key.length > 64 ? sha256(key) : key;
  const block = new Uint8Array(64);
  block.set(k);
  const inner = new Uint8Array(64 + data.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) { inner[i] = block[i] ^ 0x36; outer[i] = block[i] ^ 0x5c; }
  inner.set(data, 64);
  outer.set(sha256(inner), 64);
  k = sha256(outer);
  return k;
}
