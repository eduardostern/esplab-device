/**
 * The AssemblyScript source of the `esp` library that programs import:
 *
 *   import { pinMode, digitalWrite, delay, println, OUTPUT, HIGH, LOW } from "esp";
 *
 * It is handed to the compiler as `lib/esp.ts` (a library file), and is the only API between a
 * program and the ESP Lab Runtime firmware. The @external names must match the NativeSymbol table
 * in firmware/esplab-runtime/main/main.c.
 */
export const ESP_LIB_SOURCE = `// ESP Lab Runtime API (module "esp"). Arduino-style names.

export const LOW: i32 = 0;
export const HIGH: i32 = 1;
export const INPUT: i32 = 0;
export const OUTPUT: i32 = 1;
export const INPUT_PULLUP: i32 = 2;
export const INPUT_PULLDOWN: i32 = 3;

/** Configure a GPIO: INPUT, OUTPUT, INPUT_PULLUP or INPUT_PULLDOWN. */
@external("esp", "pinMode") export declare function pinMode(pin: i32, mode: i32): void;
/** Drive an output pin HIGH (1) or LOW (0). */
@external("esp", "digitalWrite") export declare function digitalWrite(pin: i32, value: i32): void;
/** Read a pin: 1 or 0. */
@external("esp", "digitalRead") export declare function digitalRead(pin: i32): i32;
/** 12-bit ADC reading (0..4095). ADC1 pins only: 32, 33, 34, 35, 36, 39. */
@external("esp", "analogRead") export declare function analogRead(pin: i32): i32;
/** PWM duty 0..255 at 5 kHz (LED brightness, motor speed). Up to 8 pins. */
@external("esp", "analogWrite") export declare function analogWrite(pin: i32, duty: i32): void;
/** Pause this program for ms milliseconds (other tasks keep running). */
@external("esp", "delay") export declare function delay(ms: i32): void;
/** Busy-wait up to 100000 microseconds. */
@external("esp", "delayMicroseconds") export declare function delayMicroseconds(us: i32): void;
/** Milliseconds since boot. */
@external("esp", "millis") export declare function millis(): i64;
/** Microseconds since boot. */
@external("esp", "micros") export declare function micros(): i64;
/** Random integer in [0, max). */
@external("esp", "random") export declare function random(max: i32): i32;

@external("esp", "print") declare function printUtf16(ptr: usize, bytes: i32): void;
// Numbers are formatted and parsed by the firmware (runtime 0.13+), so programs don't carry
// the number-to-text code, and printing a number creates no string.
@external("esp", "printNum") declare function printNumRaw(v: f64, decimals: i32): void;
@external("esp", "fmtNum") declare function fmtNumRaw(v: f64, decimals: i32, out: usize, capBytes: i32): i32;
@external("esp", "parseNum") declare function parseNumRaw(ptr: usize, bytes: i32): f64;

@inline function printText(text: string): void {
  printUtf16(changetype<usize>(text), text.length << 1);
}

/**
 * Write text, a number or a bool to the serial console. Numbers print as integers when whole,
 * or with "decimals" digits: print(t, 1) gives "25.5".
 */
export function print<T>(value: T, decimals: i32 = -1): void {
  if (isString<T>()) printText(changetype<string>(value));
  else if (isBoolean<T>()) printText(value ? "true" : "false");
  else if (isInteger<T>()) printNumRaw(<f64>value, 0);
  else if (isFloat<T>()) printNumRaw(<f64>value, decimals);
  else ERROR("print() takes text, a number or a bool");
}

function blank<T>(): T {
  if (isString<T>()) return changetype<T>("");
  else return <T>0;
}

/** print() and a newline. Print parts one by one (print("t = "); println(t, 1)) instead of joining strings with +. */
export function println<T = string>(value: T = blank<T>(), decimals: i32 = -1): void {
  print<T>(value, decimals);
  printText("\\n");
}

const NUM_BUF = memory.data(64);

/** A number as text: whole numbers without decimals, others shortest, or with "decimals" digits. */
export function numText(v: f64, decimals: i32 = -1): string {
  const n = fmtNumRaw(v, decimals, NUM_BUF, 64);
  return String.UTF16.decodeUnsafe(NUM_BUF, n);
}

/** The number at the start of the text (like parseFloat): NaN if there is none. */
export function parseNum(text: string): f64 {
  return parseNumRaw(changetype<usize>(text), text.length << 1);
}

/** Start the I2C bus. Returns 0 on success. */
@external("esp", "i2cBegin") export declare function i2cBegin(sda: i32, scl: i32, hz: i32): i32;
@external("esp", "i2cWrite") declare function i2cWriteRaw(address: i32, data: usize, length: i32): i32;
@external("esp", "i2cRead") declare function i2cReadRaw(address: i32, data: usize, length: i32): i32;

/** Write bytes to a 7-bit I2C address. Returns 0 on success. */
export function i2cWrite(address: i32, data: Uint8Array): i32 {
  return i2cWriteRaw(address, data.dataStart, data.length);
}

/** Read length bytes from a 7-bit I2C address; null if the device did not answer. */
export function i2cRead(address: i32, length: i32): Uint8Array | null {
  const buffer = new Uint8Array(length);
  return i2cReadRaw(address, buffer.dataStart, length) == 0 ? buffer : null;
}
`;

/** Starter program for new ESP Lab Runtime projects, blinking the board's LED. */
export function starterProgram(ledPin = 2, boardName = 'DevKit'): string {
  return STARTER_PROGRAM.replace('const LED = 2; // the DevKit\'s on-board LED', `const LED = ${ledPin}; // the ${boardName}'s on-board LED`);
}

export const STARTER_PROGRAM = `import { pinMode, digitalWrite, delay, print, println, OUTPUT, HIGH, LOW } from "esp";

const LED = 2; // the DevKit's on-board LED

let count = 0;

export function setup(): void {
  pinMode(LED, OUTPUT);
  println("hello from ESP Lab Runtime");
}

export function loop(): void {
  digitalWrite(LED, HIGH);
  delay(500);
  digitalWrite(LED, LOW);
  delay(500);
  count++;
  print("blinks: ");
  println(count);
}
`;
