/**
 * Declarations for the code editor (Monaco), so `import ... from "esp"` autocompletes.
 * Type-checking itself comes from the AssemblyScript compiler; this is only for completion/hover.
 */
export const EDITOR_TYPES = `
declare type i8 = number; declare type i16 = number; declare type i32 = number; declare type i64 = number;
declare type u8 = number; declare type u16 = number; declare type u32 = number; declare type u64 = number;
declare type f32 = number; declare type f64 = number; declare type usize = number; declare type isize = number;
declare type bool = boolean;
declare function changetype<T>(value: unknown): T;
declare function unreachable(): never;
declare class StaticArray<T> { constructor(length: i32); [index: number]: T; readonly length: i32; }

declare module "esp" {
  export const LOW: i32;
  export const HIGH: i32;
  export const INPUT: i32;
  export const OUTPUT: i32;
  export const INPUT_PULLUP: i32;
  export const INPUT_PULLDOWN: i32;
  /** Configure a GPIO: INPUT, OUTPUT, INPUT_PULLUP or INPUT_PULLDOWN. */
  export function pinMode(pin: i32, mode: i32): void;
  /** Drive an output pin HIGH (1) or LOW (0). */
  export function digitalWrite(pin: i32, value: i32): void;
  /** Read a pin: 1 or 0. */
  export function digitalRead(pin: i32): i32;
  /** 12-bit ADC reading (0..4095). ADC1 pins: 32, 33, 34, 35, 36, 39. */
  export function analogRead(pin: i32): i32;
  /** PWM duty 0..255 at 5 kHz. Up to 8 pins. */
  export function analogWrite(pin: i32, duty: i32): void;
  /** Pause for ms milliseconds. */
  export function delay(ms: i32): void;
  /** Busy-wait up to 100000 microseconds. */
  export function delayMicroseconds(us: i32): void;
  /** Milliseconds since boot (i64). */
  export function millis(): i64;
  /** Microseconds since boot (i64). */
  export function micros(): i64;
  /** Random integer in [0, max). */
  export function random(max: i32): i32;
  /** Write text, a number or a bool to the serial console; numbers whole, or with "decimals" digits. */
  export function print<T>(value: T, decimals?: i32): void;
  /** print() and a newline. Print parts one by one (print("t = "); println(t, 1)) rather than joining strings. */
  export function println<T>(value?: T, decimals?: i32): void;
  /** A number as text: whole numbers without decimals, others shortest, or with "decimals" digits. */
  export function numText(v: f64, decimals?: i32): string;
  /** The number at the start of the text (like parseFloat): NaN if there is none. */
  export function parseNum(text: string): f64;
  /** Start the I2C bus. Returns 0 on success. */
  export function i2cBegin(sda: i32, scl: i32, hz: i32): i32;
  /** Write bytes to a 7-bit I2C address. Returns 0 on success. */
  export function i2cWrite(address: i32, data: Uint8Array): i32;
  /** Read bytes from a 7-bit I2C address; null if it did not answer. */
  export function i2cRead(address: i32, length: i32): Uint8Array | null;
}

declare module "lab" {
  /** The device application. Create exactly one at the top of main.ts. */
  export class App {
    constructor(name: string, version?: string);
    /** A measured value; read() is called every everyMs; changes below deadband are not reported. */
    sensor(name: string, unit: string, read: () => f64, everyMs?: i32, deadband?: f64): Sensor;
    /** A value set from code with .set(v). */
    value(name: string, unit?: string, deadband?: f64): Sensor;
    /** A user-adjustable setting (persisted, editable from ESP Lab, apps and websites). */
    setting(name: string, unit: string, def: f64, min?: f64, max?: f64): Setting;
    /** An on/off output (relay, valve, LED). */
    relay(name: string, pin: i32, activeLow?: bool): Output;
    output(name: string, pin: i32, activeLow?: bool): Output;
    /** A debounced digital input: events "<name>.on" / "<name>.off". */
    input(name: string, pin: i32, activeLow?: bool, debounceMs?: i32, pullup?: bool): Input;
    /** A push button to GND: "<name>.on" when pressed. */
    /** A push button to GND: "<name>.press" short press, "<name>.long" held 800 ms (.autoRepeat(ms) for ".repeat", .doublePress(ms) for ".double"). */
    button(name: string, pin: i32): Input;
    /** A relay on an I2C expander bit (KinCony relays: active low). at labels it, e.g. "R3". */
    relayAt(name: string, expander: Pcf8574, bit: i32, activeLow?: bool, at?: string): Output;
    /** An input on an I2C expander bit (polled). */
    inputAt(name: string, expander: Pcf8574, bit: i32, activeLow?: bool, debounceMs?: i32, at?: string): Input;
    /** A button on an I2C expander bit (to GND), same events as button(). */
    buttonAt(name: string, expander: Pcf8574, bit: i32): Input;
    /** The label of a name (or the name). */
    labelOf(name: string): string;
    /** A command apps and websites can send. */
    command(name: string, handler: (args: Args) => void): void;
    /** Declares an event name (for the manifest). */
    event(name: string): void;
    /** The name people see for any value, setting, output, input, command, machine or state. */
    label(name: string, text: string): void;
    /** A state machine; the first state is the initial one. */
    machine(name: string, states: string[]): Machine;
    every(ms: i32, fn: () => void): void;
    after(ms: i32, fn: () => void): void;
    /** Daily at "HH:MM" local time. */
    at(hhmm: string, fn: () => void): void;
    /** Minutes east of UTC for at(), e.g. -180. */
    timezone(offsetMin: i32): void;
    /** Hooks: "boot", "online", "offline", "config", "tick", input events, emitted events. */
    on(event: string, fn: () => void): void;
    emit(event: string): void;
    emitValue(event: string, v: f64): void;
    emitText(event: string, text: string): void;
    log(text: string): void;
  }
  /** A PCF8574 / PCF8574A 8-bit I2C port expander (0x20-0x27, 0x38-0x3F; KinCony relays and inputs). Default pins SDA 4, SCL 15. */
  export class Pcf8574 { constructor(address: i32, sda?: i32, scl?: i32); readonly ok: bool; readonly address: i32; readonly pins: i32; writeBit(bit: i32, level: i32): void; readBit(bit: i32): i32; writeAll(levels: i32): void; readAll(): i32; }
  /** A PCF8575 16-bit I2C port expander (0x20-0x27). Pins 0-7 = P00-P07, 8-15 = P10-P17. Default pins SDA 21, SCL 22. */
  export class Pcf8575 extends Pcf8574 { constructor(address: i32, sda?: i32, scl?: i32); }
  export class Sensor { readonly value: f64; readonly valid: bool; set(v: f64): void; readonly name: string; label(text: string): Sensor; }
  export class Setting { readonly value: f64; set(v: f64): void; readonly name: string; label(text: string): Setting; }
  export class Output {
    readonly isOn: bool;
    readonly want: bool;
    readonly changedAt: i64;
    on(): void; off(): void; toggle(): void; set(on: bool): void;
    label(text: string): Output;
    /** Only on while other is on. */
    interlock(other: Output): Output;
    minOn(ms: i32): Output;
    minOff(ms: i32): Output;
    /** State when the program stops or crashes. */
    failsafe(on: bool): Output;
  }
  /** Inputs fire "<name>.on"/".off"; buttons also ".press" (short), ".long" (held), ".repeat" (held, with autoRepeat) and ".double". */
  export class Input { readonly value: bool; readonly name: string; label(text: string): Input; longPress(ms: i32): Input; autoRepeat(ms: i32): Input; doublePress(ms: i32): Input; }
  export class Args {
    readonly number: f64; readonly text: string;
    num(key: string, fallback?: f64): f64; str(key: string): string;
    reply(v: f64): void; replyText(s: string): void; fail(message: string): void;
  }
  export class Machine {
    /** from --event [guard]--> to. Use "tick" for conditions checked continuously. */
    on(from: string, event: string, guard: () => bool, to: string, label?: string): Machine;
    go(from: string, event: string, to: string): Machine;
    any(event: string, to: string, guard?: () => bool, label?: string): Machine;
    timeout(state: string, ms: i32, to: string): Machine;
    enter(state: string, fn: () => void): Machine;
    exit(state: string, fn: () => void): Machine;
    during(state: string, fn: () => void): Machine;
    readonly state: string;
    is(state: string): bool;
    readonly elapsed: i64;
    goto(state: string, cause?: string): void;
  }
  export class Hysteresis { constructor(low: f64, high: f64); on: bool; update(v: f64): bool; }
  export class Pid { constructor(kp: f64, ki: f64, kd: f64, outMin?: f64, outMax?: f64); update(setpoint: f64, measured: f64, dtSeconds: f64): f64; }
  export function scale(v: f64, inMin: f64, inMax: f64, outMin: f64, outMax: f64): f64;
  export function ntcCelsius(raw: f64, beta?: f64, r0?: f64, rSeries?: f64, t0?: f64): f64;
  export function epochMs(): i64;
  export function loadText(key: string): string | null;
  export function saveText(key: string, value: string): bool;
}

declare module "io" {
  export const SERIAL_8N1: i32; export const SERIAL_8E1: i32; export const SERIAL_8O1: i32; export const SERIAL_8N2: i32;
  /** A UART (port 1 or 2). dePin >= 0 drives an RS-485 transceiver's DE/RE pin. */
  export class Serial {
    constructor(port: i32, baud: i32, tx: i32, rx: i32, dePin?: i32, config?: i32);
    readonly ok: bool;
    write(data: Uint8Array): i32; print(text: string): i32; available(): i32;
    read(max: i32, timeoutMs?: i32): Uint8Array; readExactly(n: i32, timeoutMs: i32): Uint8Array;
    readLine(timeoutMs?: i32): string | null; discard(): void;
  }
  /** Modbus RTU master. Reads return null on a timeout, bad CRC or exception (see .error). */
  export class ModbusRtu {
    constructor(serial: Serial, timeoutMs?: i32, retries?: i32);
    error: string;
    readHolding(unit: i32, address: i32, count: i32): Uint16Array | null;
    readInput(unit: i32, address: i32, count: i32): Uint16Array | null;
    readCoils(unit: i32, address: i32, count: i32, discrete?: bool): bool[] | null;
    writeRegister(unit: i32, address: i32, value: i32): bool;
    writeRegisters(unit: i32, address: i32, values: u16[]): bool;
    writeCoil(unit: i32, address: i32, on: bool): bool;
  }
  export function regsToFloat(regs: Uint16Array, index: i32, swapWords?: bool): f64;
  export function regsToU32(regs: Uint16Array, index: i32, swapWords?: bool): f64;
  export function regToI16(regs: Uint16Array, index: i32): i32;
  export function crc16Modbus(data: Uint8Array, length: i32): u16;
  /** A device on the SPI bus. Call Spi.begin() once first. */
  export class Spi { static begin(sclk: i32, mosi: i32, miso: i32): bool; constructor(cs: i32, hz?: i32, mode?: i32); transfer(data: Uint8Array): bool; }
  export class OneWire { constructor(pin: i32); reset(): bool; write(value: i32): void; read(): i32; skip(): void; select(rom: Uint8Array): void; search(): Uint8Array[]; }
  /** DS18B20 probes on one 1-Wire pin; celsius(i) returns the latest reading without blocking. */
  export class Ds18b20 { constructor(pin: i32); readonly count: i32; celsius(i?: i32): f64; scan(): i32; }
  /** SSD1306 (0.96") or SH1106 (1.3") OLED on I2C, 128x64 or 128x32, address 0x3C/0x3D. Draw, then show(). Text: 5x7 font, 6x8 px per character (21 x 8 at size 1). */
  export class Ssd1306 {
    constructor(address?: i32, sda?: i32, scl?: i32, height?: i32, sh1106?: bool);
    readonly ok: bool; readonly width: i32; readonly height: i32;
    clear(): void; pixel(x: i32, y: i32, on?: bool): void; line(x0: i32, y0: i32, x1: i32, y1: i32, on?: bool): void;
    rect(x: i32, y: i32, w: i32, h: i32): void; fillRect(x: i32, y: i32, w: i32, h: i32, on?: bool): void; bar(x: i32, y: i32, w: i32, h: i32, fraction: f64): void;
    text(x: i32, y: i32, s: string, size?: i32, on?: bool): i32; textRight(y: i32, s: string, size?: i32, xRight?: i32, on?: bool): void; textCenter(y: i32, s: string, size?: i32): void; textWidth(s: string, size?: i32): i32;
    invert(on: bool): void; contrast(level: i32): void; power(on: bool): void; show(): void;
  }
  /** A ready-made front panel: status screen (states, values, outputs) and a settings/commands menu driven by up/down/OK buttons. */
  export class Panel { constructor(app: App, oled: Ssd1306, up: Input, down: Input, ok: Input, back?: Input | null, title?: string); draw(): void; }
  /** A number for a small screen: whole above 100, else one decimal, "--" for NaN. */
  export function shortNumber(v: f64): string;
  /** ADS1115 4-channel 16-bit ADC on I2C (ADDR: GND 0x48, VDD 0x49, SDA 0x4A, SCL 0x4B). Default pins SDA 21, SCL 22. NaN when a read fails. */
  export class Ads1115 { constructor(address?: i32, sda?: i32, scl?: i32); readonly ok: bool; readonly fullScale: f64; gain(fullScaleVolts: f64): Ads1115; volts(channel: i32): f64; diff(p: i32, n: i32): f64; }
  /** SX1276/77/78 (RFM95) LoRa radio. */
  export class LoRa {
    constructor(sck: i32, miso: i32, mosi: i32, nss: i32, reset: i32, dio0: i32);
    begin(frequencyHz?: f64, spreadingFactor?: i32, bandwidthHz?: i32, codingRate?: i32, txPower?: i32, syncWord?: i32): bool;
    send(data: Uint8Array): bool; receive(): void; available(): bool; sleep(): void;
    readonly packet: Uint8Array; readonly rssi: i32; readonly snr: f64;
  }
  /** This device's lab app travels over LoRa to a LoraGateway (same network key). */
  export class LoraNode { constructor(radio: LoRa, networkKey: string); }
  /** KinCony KC868-A6: relays R1-R6 and inputs IN1-IN6 on PCF8574s, RS-485, 1-Wire, 0-5 V inputs. */
  export class Kc868a6 {
    static readonly RS485_TX: i32; static readonly RS485_RX: i32; static readonly ONEWIRE_1: i32; static readonly ONEWIRE_2: i32;
    static readonly AI1: i32; static readonly AI2: i32; static readonly AI3: i32; static readonly AI4: i32;
    constructor();
    relay(app: App, name: string, n: i32): Output;
    input(app: App, name: string, n: i32, debounceMs?: i32): Input;
    rs485(baud?: i32, config?: i32): Serial;
    static volts(pin: i32): f64;
  }
  /** Pentair IntelliFlo variable-speed pump on RS-485 (9600 8N1). set(rpm) often; 0 stops. */
  export class PentairPump {
    constructor(serial: Serial, address?: i32, controller?: i32);
    set(rpm: i32): void; readonly watts: f64; readonly reportedRpm: f64; readonly running: bool;
  }
  /** Inovance MD380-compatible VFD (\"9600 series\" and many clones) on Modbus RTU. run(hz) often; 0 ramps to a stop. */
  export class Md380Drive { constructor(mb: ModbusRtu, unit?: i32, maxHz?: f64); readonly hz: f64; readonly busVolts: f64; readonly amps: f64; readonly watts: f64; readonly state: i32; readonly fault: i32; readonly ok: bool; min(hz: f64): Md380Drive; run(hz: f64): void; stop(): void; reset(): bool; poll(): void; }
  /** Pentair UltraTemp heat pump, or an AquaCal (five-button display) in External Control Mode SMART. No setpoint on the bus: call heat() while the water is below yours. */
  export class PentairHeatPump { constructor(serial: Serial, address?: i32, controller?: i32); readonly mode: i32; readonly status: i32; readonly online: bool; readonly replies: i32; heat(): void; cool(): void; off(): void; set(mode: i32): void; }
  export const HEATPUMP_OFF: i32; export const HEATPUMP_HEAT: i32; export const HEATPUMP_COOL: i32;
  /** Forwards LoRa nodes to ESP Lab; each node appears as its own device. */
  export class LoraGateway { constructor(app: App, radio: LoRa, networkKey: string, silentMs?: i32); readonly nodes: i32; readonly lastRssi: i32; readonly lastSnr: f64; readonly packets: i32; }
  type App = import("lab").App;
  type Output = import("lab").Output;
  type Input = import("lab").Input;
}
`;
