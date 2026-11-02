/**
 * The AssemblyScript source of the `io` library: buses and device drivers for programs.
 *
 *   import { Serial, ModbusRtu, OneWire, Ds18b20, Ssd1306, Panel, Spi, LoRa, LoraNode, LoraGateway } from "io";
 *
 * Serial ports and RS-485, Modbus RTU (energy meters, inverters, VFDs), 1-Wire with DS18B20
 * temperature probes, SPI, the SX1276/77/78 (RFM95) LoRa radio, and a signed LoRa link that
 * makes battery or remote nodes appear in ESP Lab through a gateway. Handed to the compiler as
 * `lib/io.ts`; the @external names match the firmware's NativeSymbol table.
 */
import { FONT5X7_AS } from './font5x7';

export const IO_LIB_SOURCE = String.raw`// ESP Lab I/O library (module "io"): buses and drivers.
import { delay, millis, print, numText, pinMode, digitalWrite, OUTPUT, i2cBegin, i2cWrite, i2cRead } from "esp";
import { App, Output, Input, Pcf8574, Setting, Args, setTransport, deliver, onSubFrame, sendToHub, watchPin, jsonString } from "lab";

@external("esp", "uartOpen") declare function uartOpenRaw(port: i32, baud: i32, tx: i32, rx: i32, de: i32, config: i32): i32;
@external("esp", "uartWrite") declare function uartWriteRaw(port: i32, data: usize, length: i32): i32;
@external("esp", "uartRead") declare function uartReadRaw(port: i32, data: usize, cap: i32, timeoutMs: i32): i32;
@external("esp", "uartAvailable") declare function uartAvailableRaw(port: i32): i32;
@external("esp", "spiBegin") declare function spiBeginRaw(sclk: i32, mosi: i32, miso: i32): i32;
@external("esp", "spiDevice") declare function spiDeviceRaw(cs: i32, hz: i32, mode: i32): i32;
@external("esp", "spiTransfer") declare function spiTransferRaw(device: i32, data: usize, length: i32): i32;
@external("esp", "owReset") declare function owResetRaw(pin: i32): i32;
@external("esp", "owBit") declare function owBitRaw(pin: i32, bit: i32): i32;
@external("esp", "owWrite") declare function owWriteRaw(pin: i32, value: i32): void;
@external("esp", "owRead") declare function owReadRaw(pin: i32): i32;
@external("esp", "hmacSha256") declare function hmacRaw(key: usize, keyLength: i32, data: usize, length: i32, out: usize, cap: i32): i32;

// ---- serial ports ---------------------------------------------------------------------------

export const SERIAL_8N1: i32 = 0;
export const SERIAL_8E1: i32 = 1;
export const SERIAL_8O1: i32 = 2;
export const SERIAL_8N2: i32 = 3;

/**
 * A UART: port 1 or 2 (the ESP32-C3 has only port 1). With dePin >= 0 it drives an RS-485
 * transceiver's DE/RE pin (MAX485 and friends).
 */
export class Serial {
  ok: bool;
  constructor(public port: i32, baud: i32, tx: i32, rx: i32, dePin: i32 = -1, config: i32 = SERIAL_8N1) {
    this.ok = uartOpenRaw(port, baud, tx, rx, dePin, config) == 0;
    if (!this.ok) print("[io] serial port " + port.toString() + " did not open (pins?)\n");
  }
  write(data: Uint8Array): i32 { return uartWriteRaw(this.port, data.dataStart, data.length); }
  print(text: string): i32 {
    const bytes = Uint8Array.wrap(String.UTF8.encode(text));
    return this.write(bytes);
  }
  /** Bytes already received. */
  available(): i32 { return uartAvailableRaw(this.port); }
  /** Up to max bytes; waits up to timeoutMs for them. */
  read(max: i32, timeoutMs: i32 = 0): Uint8Array {
    const buf = new Uint8Array(max);
    const n = uartReadRaw(this.port, buf.dataStart, max, timeoutMs);
    return n > 0 ? buf.subarray(0, n) : new Uint8Array(0);
  }
  /** Reads exactly n bytes unless timeoutMs passes first (the result is then shorter). */
  readExactly(n: i32, timeoutMs: i32): Uint8Array {
    const buf = new Uint8Array(n);
    let got = 0;
    const end = millis() + timeoutMs;
    while (got < n) {
      const left = <i32>(end - millis());
      if (left <= 0) break;
      const r = uartReadRaw(this.port, buf.dataStart + got, n - got, left);
      if (r > 0) got += r;
    }
    return buf.subarray(0, got);
  }
  /** Drops whatever is waiting in the receive buffer. */
  discard(): void {
    const buf = new Uint8Array(64);
    while (uartReadRaw(this.port, buf.dataStart, 64, 0) > 0) {}
  }
  /** A line of text without the line end, or null when none arrived within timeoutMs. */
  readLine(timeoutMs: i32 = 1000): string | null {
    let line = "";
    const end = millis() + timeoutMs;
    const one = new Uint8Array(1);
    while (millis() < end) {
      if (uartReadRaw(this.port, one.dataStart, 1, <i32>(end - millis())) <= 0) continue;
      const c = one[0];
      if (c == 10) return line;
      if (c != 13) line += String.fromCharCode(c);
    }
    return null;
  }
}

// ---- Modbus RTU (master) --------------------------------------------------------------------

export function crc16Modbus(data: Uint8Array, length: i32): u16 {
  let crc: u32 = 0xffff;
  for (let i = 0; i < length; i++) {
    crc ^= <u32>data[i];
    for (let b = 0; b < 8; b++) crc = (crc & 1) ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return <u16>crc;
}

/**
 * Modbus RTU over a Serial (usually RS-485). Reads return null on a timeout, a bad CRC or an
 * exception from the device; "error" says which.
 */
export class ModbusRtu {
  error: string = "";
  constructor(public serial: Serial, public timeoutMs: i32 = 300, public retries: i32 = 1) {}

  /** Function 3: holding registers. */
  readHolding(unit: i32, address: i32, count: i32): Uint16Array | null { return this.readRegisters(unit, 3, address, count); }
  /** Function 4: input registers. */
  readInput(unit: i32, address: i32, count: i32): Uint16Array | null { return this.readRegisters(unit, 4, address, count); }

  /** Function 1 (coils) or 2 (discrete inputs): one bool per bit. */
  readCoils(unit: i32, address: i32, count: i32, discrete: bool = false): bool[] | null {
    const reply = this.transact(this.request(unit, discrete ? 2 : 1, address, count), 5 + (count + 7) / 8);
    if (reply == null) return null;
    const out = new Array<bool>(count);
    for (let i = 0; i < count; i++) out[i] = (reply[3 + (i >> 3)] >> (i & 7) & 1) == 1;
    return out;
  }

  /** Function 6: one register. */
  writeRegister(unit: i32, address: i32, value: i32): bool {
    return this.transact(this.request(unit, 6, address, value & 0xffff), 8) != null;
  }

  /** Function 5: one coil. */
  writeCoil(unit: i32, address: i32, on: bool): bool {
    return this.transact(this.request(unit, 5, address, on ? 0xff00 : 0), 8) != null;
  }

  /** Function 16: consecutive registers. */
  writeRegisters(unit: i32, address: i32, values: u16[]): bool {
    const n = values.length;
    const frame = new Uint8Array(9 + n * 2);
    frame[0] = <u8>unit; frame[1] = 16;
    frame[2] = <u8>(address >> 8); frame[3] = <u8>address;
    frame[4] = <u8>(n >> 8); frame[5] = <u8>n; frame[6] = <u8>(n * 2);
    for (let i = 0; i < n; i++) { frame[7 + i * 2] = <u8>(values[i] >> 8); frame[8 + i * 2] = <u8>values[i]; }
    return this.transact(frame, 8) != null;
  }

  readRegisters(unit: i32, fn: i32, address: i32, count: i32): Uint16Array | null {
    if (count < 1 || count > 125) { this.error = "count must be 1..125"; return null; }
    const reply = this.transact(this.request(unit, fn, address, count), 5 + count * 2);
    if (reply == null) return null;
    const out = new Uint16Array(count);
    for (let i = 0; i < count; i++) out[i] = <u16>((<u32>reply[3 + i * 2] << 8) | reply[4 + i * 2]);
    return out;
  }

  request(unit: i32, fn: i32, a: i32, b: i32): Uint8Array {
    const frame = new Uint8Array(8);
    frame[0] = <u8>unit; frame[1] = <u8>fn;
    frame[2] = <u8>(a >> 8); frame[3] = <u8>a;
    frame[4] = <u8>(b >> 8); frame[5] = <u8>b;
    return frame;
  }

  /** Sends a request (CRC appended here) and returns the checked reply of expected length. */
  transact(frame: Uint8Array, expected: i32): Uint8Array | null {
    const n = frame.length - 2;
    const crc = crc16Modbus(frame, n);
    frame[n] = <u8>crc; frame[n + 1] = <u8>(crc >> 8);
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      this.serial.discard();
      this.serial.write(frame);
      // The first 5 bytes tell a normal reply from an exception (function | 0x80).
      const head = this.serial.readExactly(5, this.timeoutMs);
      if (head.length < 5) { this.error = "no reply"; continue; }
      if (head[0] != frame[0]) { this.error = "reply from another unit"; continue; }
      if ((head[1] & 0x80) != 0) {
        if (crc16Modbus(head, 3) != ((<u16>head[4] << 8) | head[3])) { this.error = "bad CRC"; continue; }
        this.error = "exception " + head[2].toString();
        return null;
      }
      const reply = new Uint8Array(expected);
      reply.set(head);
      if (expected > 5) {
        const rest = this.serial.readExactly(expected - 5, this.timeoutMs);
        if (rest.length < expected - 5) { this.error = "short reply"; continue; }
        reply.set(rest, 5);
      }
      if (crc16Modbus(reply, expected - 2) != ((<u16>reply[expected - 1] << 8) | reply[expected - 2])) { this.error = "bad CRC"; continue; }
      this.error = "";
      return reply;
    }
    return null;
  }
}

/** Two registers as an IEEE float (high word first unless swapped), as meters send them. */
export function regsToFloat(regs: Uint16Array, index: i32, swapWords: bool = false): f64 {
  const hi = <u32>regs[swapWords ? index + 1 : index];
  const lo = <u32>regs[swapWords ? index : index + 1];
  return <f64>reinterpret<f32>((hi << 16) | lo);
}

/** Two registers as an unsigned 32-bit number (high word first unless swapped). */
export function regsToU32(regs: Uint16Array, index: i32, swapWords: bool = false): f64 {
  const hi = <u32>regs[swapWords ? index + 1 : index];
  const lo = <u32>regs[swapWords ? index : index + 1];
  return <f64>((hi << 16) | lo);
}

/** A register as a signed 16-bit number. */
export function regToI16(regs: Uint16Array, index: i32): i32 { return <i32><i16>regs[index]; }

// ---- SPI ------------------------------------------------------------------------------------

/** A device on the SPI bus (one bus, up to 3 devices). Call Spi.begin() once first. */
export class Spi {
  static begin(sclk: i32, mosi: i32, miso: i32): bool { return spiBeginRaw(sclk, mosi, miso) == 0; }
  handle: i32;
  constructor(cs: i32, hz: i32 = 1000000, mode: i32 = 0) { this.handle = spiDeviceRaw(cs, hz, mode); }
  /** Sends the bytes and replaces them with the bytes received. */
  transfer(data: Uint8Array): bool { return this.handle >= 0 && spiTransferRaw(this.handle, data.dataStart, data.length) == 0; }
}

// ---- 1-Wire and DS18B20 ---------------------------------------------------------------------

export function crc8Maxim(data: Uint8Array, length: i32): u8 {
  let crc: u32 = 0;
  for (let i = 0; i < length; i++) {
    let b = <u32>data[i];
    for (let j = 0; j < 8; j++) {
      const mix = (crc ^ b) & 1;
      crc >>= 1;
      if (mix) crc ^= 0x8c;
      b >>= 1;
    }
  }
  return <u8>crc;
}

/** A 1-Wire bus on one GPIO (with a 4.7 kΩ pull-up to 3.3 V). */
export class OneWire {
  constructor(public pin: i32) {}
  /** true when at least one device answered. */
  reset(): bool { return owResetRaw(this.pin) == 1; }
  write(value: i32): void { owWriteRaw(this.pin, value); }
  read(): i32 { return owReadRaw(this.pin); }
  skip(): void { this.write(0xcc); }
  select(rom: Uint8Array): void {
    this.write(0x55);
    for (let i = 0; i < 8; i++) this.write(rom[i]);
  }
  /** The 8-byte ROM codes of every device on the bus (Maxim's search algorithm). */
  search(): Uint8Array[] {
    const found: Uint8Array[] = [];
    const rom = new Uint8Array(8);
    let lastDiscrepancy = 0;
    let done = false;
    while (!done && found.length < 32) {
      if (!this.reset()) break;
      this.write(0xf0);
      let lastZero = 0;
      for (let bit = 1; bit <= 64; bit++) {
        const a = owBitRaw(this.pin, 1);
        const b = owBitRaw(this.pin, 1);
        if (a == 1 && b == 1) return found; // nobody answered
        let dir: i32;
        if (a != b) dir = a;
        else {
          const known = (<i32>rom[(bit - 1) >> 3] >> ((bit - 1) & 7)) & 1;
          dir = bit < lastDiscrepancy ? known : bit == lastDiscrepancy ? 1 : 0;
          if (dir == 0) lastZero = bit;
        }
        const byte = (bit - 1) >> 3;
        const mask = 1 << ((bit - 1) & 7);
        rom[byte] = <u8>(dir ? (<i32>rom[byte] | mask) : (<i32>rom[byte] & ~mask));
        owBitRaw(this.pin, dir);
      }
      lastDiscrepancy = lastZero;
      if (lastDiscrepancy == 0) done = true;
      if (crc8Maxim(rom, 7) == rom[7]) found.push(rom.slice(0));
    }
    return found;
  }
}

export function romToHex(rom: Uint8Array): string {
  let s = "";
  for (let i = 0; i < rom.length; i++) s += (rom[i] < 16 ? "0" : "") + (<u32>rom[i]).toString(16);
  return s;
}

/**
 * DS18B20 temperature probes on one 1-Wire pin. celsius(i) does not block: probes convert in the
 * background (750 ms) and each call returns the latest reading (NaN until there is one, or when
 * a probe stops answering).
 */
export class Ds18b20 {
  bus: OneWire;
  probes: Uint8Array[] = [];
  readings: f64[] = [];
  convertingSince: i64 = -1;

  constructor(pin: i32) {
    this.bus = new OneWire(pin);
    this.scan();
  }

  /** Finds the probes on the bus again (their order is by ROM code). */
  scan(): i32 {
    const all = this.bus.search();
    this.probes = [];
    for (let i = 0; i < all.length; i++) if (all[i][0] == 0x28) this.probes.push(all[i]);
    this.readings = new Array<f64>(this.probes.length).fill(NaN);
    if (this.probes.length == 0) print("[io] no DS18B20 found on GPIO " + this.bus.pin.toString() + "\n");
    return this.probes.length;
  }

  get count(): i32 { return this.probes.length; }

  /** The latest temperature of probe i in °C. */
  celsius(i: i32 = 0): f64 {
    this.poll();
    return i < this.readings.length ? this.readings[i] : NaN;
  }

  /** Reads finished conversions and starts the next one. */
  poll(): void {
    if (this.probes.length == 0) return;
    const now = millis();
    if (this.convertingSince < 0) {
      this.start();
      delay(760); // the first reading: wait for it once
      this.collect();
      this.start();
      return;
    }
    if (now - this.convertingSince < 760) return;
    this.collect();
    this.start();
  }

  start(): void {
    if (!this.bus.reset()) { this.convertingSince = millis(); return; }
    this.bus.skip();
    this.bus.write(0x44); // convert T, all probes at once
    this.convertingSince = millis();
  }

  collect(): void {
    const data = new Uint8Array(9);
    for (let p = 0; p < this.probes.length; p++) {
      let value = NaN;
      if (this.bus.reset()) {
        this.bus.select(this.probes[p]);
        this.bus.write(0xbe); // read scratchpad
        for (let i = 0; i < 9; i++) data[i] = <u8>this.bus.read();
        if (crc8Maxim(data, 8) == data[8]) {
          const raw = <i16>((<u16>data[1] << 8) | data[0]);
          value = <f64>raw / 16.0;
          if (value == 85.0) value = NaN; // power-on value: no conversion happened
        }
      }
      this.readings[p] = value;
    }
  }
}

// ---- LoRa: SX1276/77/78 (RFM95/96/98) -------------------------------------------------------

const REG_FIFO = 0x00;
const REG_OP_MODE = 0x01;
const REG_FRF_MSB = 0x06;
const REG_PA_CONFIG = 0x09;
const REG_OCP = 0x0b;
const REG_LNA = 0x0c;
const REG_FIFO_ADDR_PTR = 0x0d;
const REG_FIFO_TX_BASE = 0x0e;
const REG_FIFO_RX_BASE = 0x0f;
const REG_FIFO_RX_CURRENT = 0x10;
const REG_IRQ_FLAGS = 0x12;
const REG_RX_NB_BYTES = 0x13;
const REG_PKT_SNR = 0x19;
const REG_PKT_RSSI = 0x1a;
const REG_MODEM_CONFIG_1 = 0x1d;
const REG_MODEM_CONFIG_2 = 0x1e;
const REG_PREAMBLE_MSB = 0x20;
const REG_PREAMBLE_LSB = 0x21;
const REG_PAYLOAD_LENGTH = 0x22;
const REG_MODEM_CONFIG_3 = 0x26;
const REG_SYNC_WORD = 0x39;
const REG_DIO_MAPPING_1 = 0x40;
const REG_VERSION = 0x42;
const REG_PA_DAC = 0x4d;
const MODE_LORA: u8 = 0x80;
const MODE_SLEEP: u8 = 0;
const MODE_STDBY: u8 = 1;
const MODE_TX: u8 = 3;
const MODE_RX_CONTINUOUS: u8 = 5;
const IRQ_TX_DONE: u8 = 0x08;
const IRQ_CRC_ERROR: u8 = 0x20;
const IRQ_RX_DONE: u8 = 0x40;

/**
 * An SX127x LoRa radio on SPI. Typical wiring (TTGO LoRa32, Heltec, RFM95 breakouts):
 * SCK 5, MISO 19, MOSI 27, NSS 18, RST 14 (or 23), DIO0 26.
 */
export class LoRa {
  spi: Spi;
  ready: bool = false;
  frequency: f64 = 0;
  /** The last packet received, with its signal. */
  packet: Uint8Array = new Uint8Array(0);
  rssi: i32 = 0;
  snr: f64 = 0;
  io: Uint8Array = new Uint8Array(2);

  constructor(public sck: i32, public miso: i32, public mosi: i32, public nss: i32, public reset: i32, public dio0: i32) {
    Spi.begin(sck, mosi, miso);
    this.spi = new Spi(nss, 8000000, 0);
  }

  read(reg: i32): u8 {
    this.io[0] = <u8>(reg & 0x7f); this.io[1] = 0;
    this.spi.transfer(this.io);
    return this.io[1];
  }

  write(reg: i32, value: i32): void {
    this.io[0] = <u8>(reg | 0x80); this.io[1] = <u8>value;
    this.spi.transfer(this.io);
  }

  /**
   * Starts the radio. frequencyHz: 868e6 (EU), 915e6 (Americas, AU), 433e6. spreadingFactor 7..12
   * (higher = longer range, slower), bandwidthHz 125000/250000/500000, codingRate 5..8 (4/5..4/8),
   * txPower 2..20 dBm. Both ends must use the same settings and sync word.
   */
  begin(frequencyHz: f64 = 915e6, spreadingFactor: i32 = 9, bandwidthHz: i32 = 125000, codingRate: i32 = 5, txPower: i32 = 17, syncWord: i32 = 0x12): bool {
    if (this.reset >= 0) {
      pinMode(this.reset, OUTPUT);
      digitalWrite(this.reset, 0); delay(2);
      digitalWrite(this.reset, 1); delay(10);
    }
    const version = this.read(REG_VERSION);
    if (version != 0x12) {
      print("[io] no SX127x LoRa radio found (version 0x" + (<u32>version).toString(16) + ")\n");
      return false;
    }
    this.write(REG_OP_MODE, MODE_LORA | MODE_SLEEP);
    this.frequency = frequencyHz;
    const frf = <u64>(frequencyHz / 32e6 * 524288.0);
    this.write(REG_FRF_MSB, <i32>(frf >> 16));
    this.write(REG_FRF_MSB + 1, <i32>(frf >> 8));
    this.write(REG_FRF_MSB + 2, <i32>frf);
    this.write(REG_FIFO_TX_BASE, 0);
    this.write(REG_FIFO_RX_BASE, 0);
    this.write(REG_LNA, this.read(REG_LNA) | 0x03); // LNA boost
    const bw = bandwidthHz <= 7800 ? 0 : bandwidthHz <= 10400 ? 1 : bandwidthHz <= 15600 ? 2 : bandwidthHz <= 20800 ? 3 : bandwidthHz <= 31250 ? 4
      : bandwidthHz <= 41700 ? 5 : bandwidthHz <= 62500 ? 6 : bandwidthHz <= 125000 ? 7 : bandwidthHz <= 250000 ? 8 : 9;
    const cr = codingRate < 5 ? 5 : codingRate > 8 ? 8 : codingRate;
    const sf = spreadingFactor < 7 ? 7 : spreadingFactor > 12 ? 12 : spreadingFactor;
    this.write(REG_MODEM_CONFIG_1, (bw << 4) | ((cr - 4) << 1)); // explicit header
    this.write(REG_MODEM_CONFIG_2, (sf << 4) | 0x04); // CRC on
    // Low data rate optimisation when a symbol lasts longer than 16 ms.
    const symbolMs = <f64>(1 << sf) / (<f64>bandwidthHz / 1000.0);
    this.write(REG_MODEM_CONFIG_3, (symbolMs > 16 ? 0x08 : 0) | 0x04); // AGC on
    this.write(REG_PREAMBLE_MSB, 0);
    this.write(REG_PREAMBLE_LSB, 8);
    this.write(REG_SYNC_WORD, syncWord);
    const power = txPower < 2 ? 2 : txPower > 20 ? 20 : txPower;
    if (power > 17) {
      this.write(REG_PA_DAC, 0x87);
      this.write(REG_OCP, 0x20 | 18); // 140 mA
      this.write(REG_PA_CONFIG, 0x80 | (power - 5));
    } else {
      this.write(REG_PA_DAC, 0x84);
      this.write(REG_OCP, 0x20 | 11); // 100 mA
      this.write(REG_PA_CONFIG, 0x80 | (power - 2));
    }
    this.write(REG_OP_MODE, MODE_LORA | MODE_STDBY);
    this.ready = true;
    this.receive();
    return true;
  }

  /** Sends one packet (up to 255 bytes) and waits until it is out; then listens again. */
  send(data: Uint8Array): bool {
    if (!this.ready || data.length == 0 || data.length > 255) return false;
    this.write(REG_OP_MODE, MODE_LORA | MODE_STDBY);
    this.write(REG_DIO_MAPPING_1, 0x40); // DIO0 = TxDone
    this.write(REG_FIFO_ADDR_PTR, 0);
    for (let i = 0; i < data.length; i++) this.write(REG_FIFO, data[i]);
    this.write(REG_PAYLOAD_LENGTH, data.length);
    this.write(REG_IRQ_FLAGS, 0xff);
    this.write(REG_OP_MODE, MODE_LORA | MODE_TX);
    const end = millis() + 4000; // SF12 at 125 kHz: a full packet takes ~3 s
    let done = false;
    while (millis() < end) {
      if ((this.read(REG_IRQ_FLAGS) & IRQ_TX_DONE) != 0) { done = true; break; }
      delay(2);
    }
    this.write(REG_IRQ_FLAGS, 0xff);
    this.receive();
    return done;
  }

  /** Listens continuously; available() reports packets. */
  receive(): void {
    this.write(REG_DIO_MAPPING_1, 0x00); // DIO0 = RxDone
    this.write(REG_OP_MODE, MODE_LORA | MODE_RX_CONTINUOUS);
  }

  /** true when a packet arrived: it is in "packet", with "rssi" and "snr". */
  available(): bool {
    if (!this.ready) return false;
    const flags = this.read(REG_IRQ_FLAGS);
    if ((flags & IRQ_RX_DONE) == 0) return false;
    this.write(REG_IRQ_FLAGS, 0xff);
    if ((flags & IRQ_CRC_ERROR) != 0) return false;
    const n = <i32>this.read(REG_RX_NB_BYTES);
    this.write(REG_FIFO_ADDR_PTR, this.read(REG_FIFO_RX_CURRENT));
    const p = new Uint8Array(n);
    for (let i = 0; i < n; i++) p[i] = this.read(REG_FIFO);
    this.packet = p;
    this.snr = <f64>(<i8>this.read(REG_PKT_SNR)) / 4.0;
    this.rssi = <i32>this.read(REG_PKT_RSSI) - (this.frequency < 779e6 ? 164 : 157);
    return true;
  }

  sleep(): void { this.write(REG_OP_MODE, MODE_LORA | MODE_SLEEP); }
}

// ---- ADS1115 16-bit ADC (I2C) ---------------------------------------------------------------

/**
 * A TI ADS1115: four analog inputs, 16 bits, on I2C. The ADDR pin picks the address: GND 0x48,
 * VDD 0x49, SDA 0x4A, SCL 0x4B. volts(ch) measures AIN0-AIN3 against GND; diff(p, n) measures
 * the pairs 0-1, 0-3, 1-3 and 2-3. gain(fs) sets the full-scale range in volts: 6.144, 4.096
 * (default), 2.048, 1.024, 0.512 or 0.256. Whatever the range, inputs must stay between GND
 * and VDD. Unlike the ESP32's own ADC it is linear and accurate to about 0.1 %.
 * A failed read returns NaN and clears ok.
 */
export class Ads1115 {
  ok: bool;
  fullScale: f64 = 4.096;
  private pga: i32 = 1;
  private cmd: Uint8Array = new Uint8Array(3);
  private ptr: Uint8Array = new Uint8Array(1);
  constructor(public address: i32 = 0x48, sda: i32 = 21, scl: i32 = 22) {
    i2cBegin(sda, scl, 100000);
    this.ptr[0] = 1;
    this.ok = i2cWrite(address, this.ptr) == 0;
    if (!this.ok) print("[io] no ADS1115 answered at 0x" + (<u32>address).toString(16) + "\n");
  }
  /** Full-scale range in volts (the nearest one at or above fs). */
  gain(fs: f64): Ads1115 {
    const ranges: f64[] = [6.144, 4.096, 2.048, 1.024, 0.512, 0.256];
    let pick = 0;
    for (let i = 0; i < ranges.length; i++) if (ranges[i] >= fs) pick = i;
    this.pga = pick;
    this.fullScale = ranges[pick];
    return this;
  }
  /** Volts on AIN0-AIN3 against GND. */
  volts(channel: i32): f64 {
    if (channel < 0 || channel > 3) return NaN;
    return this.measure(4 + channel);
  }
  /** Volts between two inputs: (0,1), (0,3), (1,3) or (2,3). */
  diff(p: i32, n: i32): f64 {
    if (p == 0 && n == 1) return this.measure(0);
    if (p == 0 && n == 3) return this.measure(1);
    if (p == 1 && n == 3) return this.measure(2);
    if (p == 2 && n == 3) return this.measure(3);
    return NaN;
  }
  /** One single-shot conversion (475 samples/s, about 2 ms) with input multiplexer code mux. */
  measure(mux: i32): f64 {
    const config = 0x8000 | (mux << 12) | (this.pga << 9) | 0x0100 | (6 << 5) | 0x03;
    this.cmd[0] = 1;
    this.cmd[1] = <u8>(config >> 8);
    this.cmd[2] = <u8>(config & 0xff);
    if (i2cWrite(this.address, this.cmd) != 0) return this.fail();
    for (let i = 0; i < 20; i++) {
      const c = i2cRead(this.address, 2);
      if (c == null) return this.fail();
      if (c[0] & 0x80) break; // OS = 1: conversion done
      delay(1);
    }
    this.ptr[0] = 0;
    if (i2cWrite(this.address, this.ptr) != 0) return this.fail();
    const d = i2cRead(this.address, 2);
    this.ptr[0] = 1;
    if (d == null) return this.fail();
    const code = <i32><i16>((<i32>d[0] << 8) | <i32>d[1]);
    this.ok = true;
    return <f64>code * this.fullScale / 32768.0;
  }
  private fail(): f64 { this.ok = false; return NaN; }
}

// ---- Inovance MD380-compatible VFDs (Modbus RTU) -----------------------------------------------
//
// The MD380's register map is shared by a large family of Chinese vector drives sold under many
// names (the "9600 series", and most drives whose manual has groups P0-PE, A0-AC and U0 with
// PD-00 = 6005 as the baud default). Writes (function 6): 0x1000 speed command in 0.01 % of the
// maximum frequency P0-10, 0x2000 command (1 forward, 2 reverse, 5 coast stop, 6 ramp stop,
// 7 fault reset). Reads (function 3): 0x3000 state (1 forward, 2 reverse, 3 stopped), 0x8000
// fault code (0 = none, n = Err n), 0x7000.. the U0 monitor group (running frequency 0.01 Hz,
// set frequency, bus voltage 0.1 V, output voltage 1 V, output current 0.01 A, power 0.1 kW).
// On the drive: P0-02 = 2 (run commands from the bus), P0-03 = 9 (frequency from the bus),
// PD-00 = 5 (9600), PD-01 = 3 (8N1), PD-02 = address, PD-05 = 31 (standard Modbus), and
// PD-04 = 3.0 s so the drive stops by itself if the controller goes silent.

export class Md380Drive {
  /** Running frequency, Hz (NaN until read). */
  hz: f64 = NaN;
  busVolts: f64 = NaN;
  amps: f64 = NaN;
  watts: f64 = NaN;
  /** 1 forward, 2 reverse, 3 stopped, -1 unknown. */
  state: i32 = -1;
  /** Fault code (Err n), 0 = none, -1 unknown. */
  fault: i32 = -1;
  /** The drive answered the last poll. */
  ok: bool = false;
  wantHz: f64 = 0;
  lastSent: i64 = -100000;
  minHz: f64 = 0;
  constructor(public mb: ModbusRtu, public unit: i32 = 1, public maxHz: f64 = 50) {}

  /** Lowest running frequency (pumps lose prime and motors cool badly below ~25 Hz). */
  min(hz: f64): Md380Drive { this.minHz = hz; return this; }

  /** Runs forward at hz, or ramps to a stop with 0. Call often: it repeats and polls every 2 s. */
  run(hz: f64): void {
    let want = hz <= 0 ? 0 : hz < this.minHz ? this.minHz : hz > this.maxHz ? this.maxHz : hz;
    const now = millis();
    if (want == this.wantHz && now - this.lastSent < 2000) return;
    this.wantHz = want;
    this.lastSent = now;
    let ok = true;
    if (want > 0) {
      ok = this.mb.writeRegister(this.unit, 0x1000, <i32>Math.round(want / this.maxHz * 10000)) && ok;
      ok = this.mb.writeRegister(this.unit, 0x2000, 1) && ok;
    } else {
      ok = this.mb.writeRegister(this.unit, 0x2000, 6) && ok;
    }
    this.poll();
    this.ok = this.ok && ok;
  }
  stop(): void { this.run(0); }

  /** Clears a fault (the drive must be told to run again afterwards). */
  reset(): bool { this.lastSent = -100000; return this.mb.writeRegister(this.unit, 0x2000, 7); }

  /** Reads state, fault and the U0 monitor values. */
  poll(): void {
    const st = this.mb.readHolding(this.unit, 0x3000, 1);
    const f = this.mb.readHolding(this.unit, 0x8000, 1);
    const u = this.mb.readHolding(this.unit, 0x7000, 6);
    this.ok = st != null && f != null && u != null;
    if (st != null) this.state = <i32>st[0];
    if (f != null) this.fault = <i32>f[0];
    if (u != null) {
      this.hz = <f64>u[0] / 100;
      this.busVolts = <f64>u[2] / 10;
      this.amps = <f64>u[4] / 100;
      this.watts = <f64>u[5] * 100;
    }
  }
}

// ---- KinCony KC868-A6 ------------------------------------------------------------------------

/**
 * The KinCony KC868-A6: six relays (R1-R6) and six inputs (IN1-IN6) on PCF8574 expanders
 * (I2C on GPIO 4/15, relays at 0x24, inputs at 0x22, both active low), RS-485 (TX 27, RX 14,
 * automatic direction), two 1-Wire ports (GPIO 32, 33) and four 0-5 V analog inputs.
 */
export class Kc868a6 {
  static readonly RS485_TX: i32 = 27;
  static readonly RS485_RX: i32 = 14;
  static readonly ONEWIRE_1: i32 = 32;
  static readonly ONEWIRE_2: i32 = 33;
  static readonly AI1: i32 = 36;
  static readonly AI2: i32 = 39;
  static readonly AI3: i32 = 34;
  static readonly AI4: i32 = 35;
  relays: Pcf8574;
  inputs: Pcf8574;
  constructor() {
    this.relays = new Pcf8574(0x24, 4, 15);
    this.inputs = new Pcf8574(0x22, 4, 15);
  }
  /** Relay n (1-6) as a lab output. */
  relay(app: App, name: string, n: i32): Output { return app.relayAt(name, this.relays, n - 1, true, "R" + n.toString()); }
  /** Input n (1-6) as a lab input: "on" while the input is connected to GND (dry contact closed). */
  input(app: App, name: string, n: i32, debounceMs: i32 = 50): Input { return app.inputAt(name, this.inputs, n - 1, true, debounceMs, "IN" + n.toString()); }
  /** The RS-485 port. */
  rs485(baud: i32 = 9600, config: i32 = SERIAL_8N1): Serial { return new Serial(2, baud, Kc868a6.RS485_TX, Kc868a6.RS485_RX, -1, config); }
  /** An analog input (AI1-AI4) in volts, 0-5 V. */
  static volts(pin: i32): f64 { return <f64>analogReadRaw(pin) / 4095.0 * 5.0; }
}

@external("esp", "analogRead") declare function analogReadRaw(pin: i32): i32;

// ---- Pentair IntelliFlo variable-speed pumps (RS-485) ----------------------------------------
//
// The pump takes commands from a controller at 9600 8N1: [FF 00 FF] A5 00 <pump> <controller>
// <action> <length> <data...> <checksum hi lo>, checksum = sum of the bytes from A5 on. It must
// hear from the controller regularly or it goes back to its own panel, so commands repeat.

export class PentairPump {
  rpm: i32 = 0;
  watts: f64 = NaN;
  reportedRpm: f64 = NaN;
  running: bool = false;
  lastSent: i64 = -100000;
  replies: i32 = 0;
  constructor(public serial: Serial, public address: i32 = 0x60, public controller: i32 = 0x10) {}

  /** Runs at rpm (450-3450), or stops with 0. Call often (each loop or every few seconds): it repeats every 10 s. */
  set(rpm: i32): void {
    const want = rpm <= 0 ? 0 : rpm < 450 ? 450 : rpm > 3450 ? 3450 : rpm;
    const now = millis();
    if (want == this.rpm && now - this.lastSent < 10000) return;
    this.rpm = want;
    this.lastSent = now;
    const remote: u8[] = [0xff];
    this.command(4, remote);                         // remote control: the panel is locked out
    if (want > 0) {
      const speed: u8[] = [0x02, 0xc4, <u8>(want >> 8), <u8>want];
      this.command(1, speed);                        // RPM
      const run: u8[] = [0x0a];
      this.command(6, run);                          // run
    } else {
      const stop: u8[] = [0x04];
      this.command(6, stop);                         // stop
      const local: u8[] = [0x00];
      this.command(4, local);                        // back to the pump's own panel
    }
    this.running = want > 0;
    const none: u8[] = [];
    this.command(7, none);                           // status: watts and RPM
  }

  command(action: i32, data: u8[]): void {
    const d = pentairExchange(this.serial, this.address, this.controller, action, data, action);
    if (d == null) return;
    this.replies++;
    // A status answer (action 7) carries watts and RPM.
    if (action == 7 && d.length >= 7) {
      this.watts = <f64>((<u32>d[3] << 8) | d[4]);
      this.reportedRpm = <f64>((<u32>d[5] << 8) | d[6]);
    }
  }
}

/**
 * One Pentair bus exchange: sends [FF 00 FF] A5 00 <to> <from> <action> <length> <data> <sum>
 * and returns the payload of the first valid answer from "to" with action "answer" (null if
 * none within 150 ms).
 */
export function pentairExchange(serial: Serial, to: i32, from: i32, action: i32, data: u8[], answer: i32): Uint8Array | null {
  const n = data.length;
  const frame = new Uint8Array(3 + 6 + n + 2);
  frame[0] = 0xff; frame[1] = 0x00; frame[2] = 0xff;
  frame[3] = 0xa5; frame[4] = 0x00; frame[5] = <u8>to; frame[6] = <u8>from; frame[7] = <u8>action; frame[8] = <u8>n;
  for (let i = 0; i < n; i++) frame[9 + i] = data[i];
  let sum: u32 = 0;
  for (let i = 3; i < 9 + n; i++) sum += <u32>frame[i];
  frame[9 + n] = <u8>(sum >> 8); frame[10 + n] = <u8>sum;
  serial.discard();
  serial.write(frame);
  const reply = serial.read(64, 150);
  for (let i = 0; i + 8 < reply.length; i++) {
    if (reply[i] != 0xa5 || reply[i + 3] != <u8>to || reply[i + 4] != <u8>answer) continue;
    const len = <i32>reply[i + 5];
    if (i + 6 + len + 2 > reply.length) return null;
    let check: u32 = 0;
    for (let k = i; k < i + 6 + len; k++) check += <u32>reply[k];
    if (((<u32>reply[i + 6 + len] << 8) | reply[i + 7 + len]) != (check & 0xffff)) return null;
    return reply.slice(i + 6, i + 6 + len);
  }
  return null;
}

// ---- Pentair UltraTemp heat pumps, and AquaCal heat pumps in SMART mode (RS-485) -------------
//
// AquaCal units with the five-button display (HP9/HP11 board, "Port B") join a Pentair bus as an
// UltraTemp once set to External Control Mode = SMART (installer code 17). The controller asks
// for off, heat or cool (action 0x72: 90 <mode> 00 x8); the heat pump answers with what it is
// doing (action 0x73: A0 01 <status> ...). There is no setpoint on the bus: the heat pump runs to
// its own maximum while called, so the program decides when to call, from its own water sensor.
// Protocol from nodejs-poolController (NixieUltratemp, HeaterStateMessage).

export const HEATPUMP_OFF: i32 = 0;
export const HEATPUMP_HEAT: i32 = 1;
export const HEATPUMP_COOL: i32 = 2;

export class PentairHeatPump {
  /** What the program asks for: HEATPUMP_OFF, _HEAT or _COOL. */
  mode: i32 = HEATPUMP_OFF;
  /** What the heat pump says it is doing (same codes), -1 before the first answer. */
  status: i32 = -1;
  replies: i32 = 0;
  lastReplyAt: i64 = -1;
  lastSent: i64 = -100000;
  /** address: 112 (0x70) is heater 1; AquaCal "Local Address" 0 maps to it. */
  constructor(public serial: Serial, public address: i32 = 112, public controller: i32 = 0x10) {}

  heat(): void { this.set(HEATPUMP_HEAT); }
  cool(): void { this.set(HEATPUMP_COOL); }
  off(): void { this.set(HEATPUMP_OFF); }

  /** Asks for a mode. Call often: it sends on a change and every 5 s (the heat pump expects a steady poll). */
  set(mode: i32): void {
    const now = millis();
    if (mode == this.mode && now - this.lastSent < 5000) return;
    this.mode = mode;
    this.lastSent = now;
    const data: u8[] = [0x90, <u8>mode, 0, 0, 0, 0, 0, 0, 0, 0];
    const d = pentairExchange(this.serial, this.address, this.controller, 0x72, data, 0x73);
    if (d == null || d.length < 3) return;
    this.replies++;
    this.lastReplyAt = now;
    this.status = <i32>d[2];
  }

  /** Answered within the last 30 s. */
  get online(): bool { return this.lastReplyAt >= 0 && millis() - this.lastReplyAt < 30000; }
}

// ---- the ESP Lab LoRa link: nodes reach the hub through a gateway --------------------------
//
// Packet: [0xE5][flags][node 4][session 2][seq 2][fragment: index << 4 | count][data...][MIC 4]
//   flags bit 0: downlink (gateway -> node). node: FNV-1a hash of the node's device id.
//   MIC: the first 4 bytes of HMAC-SHA256(network key, everything before it).
// A frame longer than one packet (a node's hello with its manifest) is split in up to 15 parts.

const LINK_MAGIC: u8 = 0xe5;
const LINK_HEADER = 11;
const LINK_MIC = 4;
const LINK_CHUNK = 255 - LINK_HEADER - LINK_MIC;

export function fnv1a(text: string): u32 {
  let h: u32 = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= <u32>(text.charCodeAt(i) & 0xff);
    h *= 0x01000193;
  }
  return h;
}

function hmac4(key: Uint8Array, data: Uint8Array, length: i32): Uint8Array {
  const out = new Uint8Array(32);
  hmacRaw(key.dataStart, key.length, data.dataStart, length, out.dataStart, 32);
  return out.subarray(0, 4);
}

/** UTF-16 text from the lab framework's frame writer as UTF-8 bytes. */
function utf16ToUtf8(ptr: usize, bytes: i32): Uint8Array {
  const text = String.UTF16.decodeUnsafe(ptr, bytes);
  return Uint8Array.wrap(String.UTF8.encode(text));
}

/** Splits and signs messages; checks and reassembles them on the other side. */
class Link {
  key: Uint8Array;
  session: u16;
  seq: u16 = 0;
  // Reassembly, per peer (node hash): the message in progress and the last accepted sequence.
  peers: u32[] = [];
  peerSession: u16[] = [];
  peerSeq: i32[] = [];
  partSeq: i32[] = [];
  parts: Array<Array<Uint8Array | null>> = [];
  sent: i32 = 0;
  received: i32 = 0;
  rejected: i32 = 0;

  constructor(public radio: LoRa, networkKey: string) {
    this.key = Uint8Array.wrap(String.UTF8.encode(networkKey));
    this.session = <u16>(<u32>millis() ^ <u32>(Math.random() * 65535.0));
    if (networkKey.length < 12) print("[io] the LoRa network key should be at least 12 characters\n");
  }

  sendMessage(node: u32, downlink: bool, message: Uint8Array): bool {
    const count = (message.length + LINK_CHUNK - 1) / LINK_CHUNK;
    if (count > 15) { print("[io] LoRa message too long (" + message.length.toString() + " bytes)\n"); return false; }
    this.seq++;
    let ok = true;
    for (let i = 0; i < count; i++) {
      const start = i * LINK_CHUNK;
      const end = min(start + LINK_CHUNK, message.length);
      const p = new Uint8Array(LINK_HEADER + (end - start) + LINK_MIC);
      p[0] = LINK_MAGIC;
      p[1] = downlink ? 1 : 0;
      p[2] = <u8>node; p[3] = <u8>(node >> 8); p[4] = <u8>(node >> 16); p[5] = <u8>(node >> 24);
      p[6] = <u8>this.session; p[7] = <u8>(this.session >> 8);
      p[8] = <u8>this.seq; p[9] = <u8>(this.seq >> 8);
      p[10] = <u8>((i << 4) | count);
      p.set(message.subarray(start, end), LINK_HEADER);
      const n = p.length - LINK_MIC;
      p.set(hmac4(this.key, p, n), n);
      if (!this.radio.send(p)) ok = false;
      this.sent++;
    }
    return ok;
  }

  /** A complete, verified message from a packet, or null (more parts to come, or rejected). */
  accept(p: Uint8Array, wantDownlink: bool): Uint8Array | null {
    if (p.length < LINK_HEADER + LINK_MIC + 1 || p[0] != LINK_MAGIC || ((p[1] & 1) == 1) != wantDownlink) return null;
    const n = p.length - LINK_MIC;
    const mic = hmac4(this.key, p, n);
    for (let i = 0; i < LINK_MIC; i++) if (mic[i] != p[n + i]) { this.rejected++; return null; }
    const node = <u32>p[2] | (<u32>p[3] << 8) | (<u32>p[4] << 16) | (<u32>p[5] << 24);
    const session = <u16>(<u32>p[6] | (<u32>p[7] << 8));
    const seq = <i32>(<u32>p[8] | (<u32>p[9] << 8));
    const index = <i32>(p[10] >> 4);
    const count = <i32>(p[10] & 15);
    if (count == 0 || index >= count) return null;
    let k = this.peers.indexOf(node);
    if (k < 0) {
      k = this.peers.length;
      this.peers.push(node); this.peerSession.push(session); this.peerSeq.push(-1); this.partSeq.push(-1);
      this.parts.push([]);
    }
    if (this.peerSession[k] != session) { this.peerSession[k] = session; this.peerSeq[k] = -1; this.partSeq[k] = -1; }
    // Replays and duplicates: sequence numbers only go up within a session.
    if (this.peerSeq[k] >= 0) {
      const ahead = (seq - this.peerSeq[k]) & 0xffff;
      if (ahead == 0 || ahead > 0x8000) return null;
    }
    if (this.partSeq[k] != seq) {
      this.partSeq[k] = seq;
      const fresh = new Array<Uint8Array | null>(count);
      for (let i = 0; i < count; i++) fresh[i] = null;
      this.parts[k] = fresh;
    }
    const list = this.parts[k];
    if (list.length != count) return null;
    list[index] = p.slice(LINK_HEADER, n);
    let total = 0;
    for (let i = 0; i < count; i++) {
      const part = list[i];
      if (part == null) return null;
      total += part.length;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (let i = 0; i < count; i++) { const part = list[i]!; out.set(part, at); at += part.length; }
    this.peerSeq[k] = seq;
    this.partSeq[k] = -1;
    this.received++;
    return out;
  }

  /** The node hash of a packet. */
  static nodeOf(p: Uint8Array): u32 {
    return <u32>p[2] | (<u32>p[3] << 8) | (<u32>p[4] << 16) | (<u32>p[5] << 24);
  }
}

let theNode: LoraNode | null = null;

/**
 * Makes this device a LoRa node: its frames (values, events, answers) go over the radio to a
 * LoraGateway, which forwards them to ESP Lab; commands and settings come back the same way.
 * The node shows up in ESP Lab as its own device. Use the same network key on the gateway.
 */
export class LoraNode {
  link: Link;
  id: string;
  hash: u32;

  constructor(public radio: LoRa, networkKey: string) {
    this.link = new Link(radio, networkKey);
    // The device id ("esp32-..."), as hello frames carry it.
    this.id = deviceIdText();
    this.hash = fnv1a(this.id);
    theNode = this;
    setTransport(nodeTransmit);
    watchPin(radio.dio0, nodePoll);
  }
}

@external("esp", "deviceId") declare function deviceIdRaw(out: usize, cap: i32): i32;

function deviceIdText(): string {
  const buf = new Uint8Array(32);
  const n = deviceIdRaw(buf.dataStart, 32);
  return n > 0 ? String.UTF8.decodeUnsafe(buf.dataStart, n) : "esp32-unknown";
}

function nodeTransmit(ptr: usize, bytes: i32): void {
  const node = theNode;
  if (node == null) return;
  node.link.sendMessage(node.hash, false, utf16ToUtf8(ptr, bytes));
}

function nodePoll(): void {
  const node = theNode;
  if (node == null) return;
  while (node.radio.available()) {
    const p = node.radio.packet;
    if (p.length < LINK_HEADER || Link.nodeOf(p) != node.hash) continue;
    const message = node.link.accept(p, true);
    if (message != null) deliver(String.UTF8.decode(message.buffer));
  }
}

let theGateway: LoraGateway | null = null;

/**
 * Makes this device a LoRa gateway: it forwards its nodes' frames to ESP Lab, where each node
 * appears as a device of its own ("via" this gateway), and sends commands and settings back.
 * Nodes not heard for silentMs are reported offline.
 */
export class LoraGateway {
  link: Link;
  ids: string[] = [];
  hashes: u32[] = [];
  lastHeard: i64[] = [];
  online: bool[] = [];
  lastRssi: i32 = 0;
  lastSnr: f64 = 0;
  packets: i32 = 0;

  constructor(public app: App, public radio: LoRa, networkKey: string, public silentMs: i32 = 600000) {
    this.link = new Link(radio, networkKey);
    theGateway = this;
    onSubFrame(gatewayDownlink);
    watchPin(radio.dio0, gatewayPoll);
    app.every(30000, gatewayCheckSilent);
  }

  /** Nodes heard so far. */
  get nodes(): i32 { return this.ids.length; }

  indexOf(hash: u32): i32 { return this.hashes.indexOf(hash); }

  uplink(hash: u32, message: Uint8Array): void {
    const text = String.UTF8.decode(message.buffer);
    let k = this.indexOf(hash);
    if (k < 0) {
      // A node we do not know yet: its hello names it; otherwise ask it for one.
      const id = helloId(text);
      if (id.length == 0 || fnv1a(id) != hash) {
        this.link.sendMessage(hash, true, Uint8Array.wrap(String.UTF8.encode('{"t":"sync"}')));
        return;
      }
      k = this.ids.length;
      this.ids.push(id); this.hashes.push(hash); this.lastHeard.push(0); this.online.push(false);
    }
    this.lastHeard[k] = millis();
    this.online[k] = true;
    sendToHub('{"t":"sub","id":' + jsonString(this.ids[k]) + ',"rssi":' + this.radio.rssi.toString() + ',"f":' + text + "}");
  }
}

function helloId(text: string): string {
  if (text.indexOf('"t":"hello"') < 0) return "";
  const at = text.indexOf('"id":"');
  if (at < 0) return "";
  const end = text.indexOf('"', at + 6);
  return end < 0 ? "" : text.substring(at + 6, end);
}

function gatewayPoll(): void {
  const gw = theGateway;
  if (gw == null) return;
  while (gw.radio.available()) {
    const p = gw.radio.packet;
    gw.packets++;
    gw.lastRssi = gw.radio.rssi;
    gw.lastSnr = gw.radio.snr;
    if (p.length < LINK_HEADER) continue;
    const hash = Link.nodeOf(p);
    const message = gw.link.accept(p, false);
    if (message != null) gw.uplink(hash, message);
  }
}

/** {"t":"sub","id":"<node>","f":<frame>} from ESP Lab: send the frame to the node. */
function gatewayDownlink(text: string): void {
  const gw = theGateway;
  if (gw == null) return;
  const idAt = text.indexOf('"id":"');
  const fAt = text.indexOf('"f":');
  if (idAt < 0 || fAt < 0) return;
  const id = text.substring(idAt + 6, text.indexOf('"', idAt + 6));
  const frame = text.substring(fAt + 4, text.lastIndexOf("}"));
  gw.link.sendMessage(fnv1a(id), true, Uint8Array.wrap(String.UTF8.encode(frame)));
}

function gatewayCheckSilent(): void {
  const gw = theGateway;
  if (gw == null) return;
  const now = millis();
  for (let k = 0; k < gw.ids.length; k++) {
    if (gw.online[k] && now - gw.lastHeard[k] > gw.silentMs) {
      gw.online[k] = false;
      sendToHub('{"t":"sub","id":' + jsonString(gw.ids[k]) + ',"f":{"t":"bye"}}');
    }
  }
}

// ---- SSD1306 / SH1106 OLED displays (I2C) ----------------------------------------------------

${FONT5X7_AS}

/**
 * A 0.96" SSD1306 (or 1.3" SH1106) OLED on I2C, 128x64 or 128x32, address 0x3C (0x3D with the
 * module's address jumper moved). Draw into the buffer, then show() sends the changed parts.
 * Text uses a 5x7 font (6 x 8 pixels per character at size 1: 21 characters x 8 lines).
 */
export class Ssd1306 {
  readonly width: i32 = 128;
  ok: bool = false;
  buf: Uint8Array;
  private pages: i32;
  /** What the display shows now: show() sends only the pages that differ (I2C is slow). */
  private shown: Uint8Array;
  private fresh: bool = true;
  private out: Uint8Array = new Uint8Array(129);
  private cmd1: Uint8Array = new Uint8Array(2);
  constructor(public address: i32 = 0x3c, sda: i32 = 21, scl: i32 = 22, public height: i32 = 64, public sh1106: bool = false) {
    this.buf = new Uint8Array(128 * (height / 8));
    this.shown = new Uint8Array(128 * (height / 8));
    this.pages = height / 8;
    i2cBegin(sda, scl, 100000);
    this.begin();
  }
  private command(c: i32): bool {
    this.cmd1[0] = 0x00;
    this.cmd1[1] = <u8>c;
    return i2cWrite(this.address, this.cmd1) == 0;
  }
  /** Sends the power-on sequence; called by the constructor. ok tells whether the display answered. */
  begin(): bool {
    const ssd: i32[] = [0xae, 0xd5, 0x80, 0xa8, this.height - 1, 0xd3, 0x00, 0x40, 0x8d, 0x14, 0x20, 0x00, 0xa1, 0xc8, 0xda, this.height == 64 ? 0x12 : 0x02, 0x81, 0xcf, 0xd9, 0xf1, 0xdb, 0x40, 0xa4, 0xa6, 0xaf];
    const sh: i32[] = [0xae, 0xd5, 0x80, 0xa8, this.height - 1, 0xd3, 0x00, 0x40, 0xad, 0x8b, 0xa1, 0xc8, 0xda, 0x12, 0x81, 0x80, 0xd9, 0x22, 0xdb, 0x35, 0xa4, 0xa6, 0xaf];
    const seq = this.sh1106 ? sh : ssd;
    this.ok = true;
    for (let i = 0; i < seq.length; i++) this.ok = this.command(seq[i]) && this.ok;
    if (!this.ok) print("[io] no OLED answered at 0x" + (<u32>this.address).toString(16) + "\n");
    this.clear();
    this.fresh = true;
    this.show();
    return this.ok;
  }
  clear(): void { this.buf.fill(0); }
  pixel(x: i32, y: i32, on: bool = true): void {
    if (x < 0 || x >= 128 || y < 0 || y >= this.height) return;
    const at = (y >> 3) * 128 + x;
    const bit: i32 = 1 << (y & 7);
    const before: i32 = this.buf[at];
    const after: i32 = on ? before | bit : before & ~bit;
    if (after != before) this.buf[at] = <u8>after;
  }
  fillRect(x: i32, y: i32, w: i32, h: i32, on: bool = true): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.pixel(i, j, on);
  }
  rect(x: i32, y: i32, w: i32, h: i32): void {
    this.line(x, y, x + w - 1, y); this.line(x, y + h - 1, x + w - 1, y + h - 1);
    this.line(x, y, x, y + h - 1); this.line(x + w - 1, y, x + w - 1, y + h - 1);
  }
  line(x0: i32, y0: i32, x1: i32, y1: i32, on: bool = true): void {
    const dx = abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.pixel(x0, y0, on);
      if (x0 == x1 && y0 == y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  /** A horizontal bar filled to fraction (0..1), e.g. a tank level. */
  bar(x: i32, y: i32, w: i32, h: i32, fraction: f64): void {
    this.rect(x, y, w, h);
    const f = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
    this.fillRect(x + 2, y + 2, <i32>Math.round(<f64>(w - 4) * f), h - 4);
  }
  /** Text at (x, y) (top-left), size 1-4; returns the x after it. on = false draws dark text (on a lit area). */
  text(x: i32, y: i32, s: string, size: i32 = 1, on: bool = true): i32 {
    for (let i = 0; i < s.length; i++) {
      const g = glyphIndex(s.charCodeAt(i)) * 5;
      for (let col = 0; col < 5; col++) {
        const bits: i32 = FONT5X7[g + col];
        for (let row = 0; row < 7; row++) {
          if ((bits >> row) & 1) {
            if (size == 1) this.pixel(x + col, y + row, on);
            else this.fillRect(x + col * size, y + row * size, size, size, on);
          }
        }
      }
      x += 6 * size;
    }
    return x;
  }
  /** Width of a text in pixels. */
  textWidth(s: string, size: i32 = 1): i32 { return s.length * 6 * size; }
  /** Text ending at the right edge (or at xRight). */
  textRight(y: i32, s: string, size: i32 = 1, xRight: i32 = 128, on: bool = true): void { this.text(xRight - this.textWidth(s, size) + size, y, s, size, on); }
  /** Text centred on the screen. */
  textCenter(y: i32, s: string, size: i32 = 1): void { this.text((128 - this.textWidth(s, size) + size) / 2, y, s, size); }
  invert(on: bool): void { this.command(on ? 0xa7 : 0xa6); }
  contrast(level: i32): void { this.command(0x81); this.command(level & 0xff); }
  /** Panel on (true) or off (false, keeps the picture). */
  power(on: bool): void { this.command(on ? 0xaf : 0xae); }
  /** Sends the parts of the picture that changed since the last show() (unchanged: nothing is sent). */
  show(): void {
    for (let p = 0; p < this.pages; p++) {
      let same = !this.fresh;
      for (let i = 0; same && i < 128; i++) same = this.buf[p * 128 + i] == this.shown[p * 128 + i];
      if (same) continue;
      if (this.sh1106) {
        this.command(0xb0 | p); this.command(0x02); this.command(0x10);
      } else {
        this.command(0x21); this.command(0); this.command(127);
        this.command(0x22); this.command(p); this.command(p);
      }
      this.out[0] = 0x40;
      for (let i = 0; i < 128; i++) { const b = this.buf[p * 128 + i]; this.out[1 + i] = b; this.shown[p * 128 + i] = b; }
      this.ok = i2cWrite(this.address, this.out) == 0;
    }
    this.fresh = false;
  }
}

/** A number for a small screen: whole above 100, else one decimal; "--" when unknown. */
export function shortNumber(v: f64): string {
  if (isNaN(v)) return "--";
  if (Math.abs(v) >= 100) return numText(Math.round(v), 0);
  const tenths = Math.round(v * 10);
  return numText(tenths == 0 ? 0 : tenths / 10, 1);
}

// ---- Panel: a front panel for a lab app (display + buttons) ----------------------------------

let thePanel: Panel | null = null;
function panelTick(): void { const p = thePanel; if (p != null) p.tick(); }
function panelUp(): void { const p = thePanel; if (p != null) p.key(1); }
function panelDown(): void { const p = thePanel; if (p != null) p.key(2); }
function panelOk(): void { const p = thePanel; if (p != null) p.key(3); }
function panelBack(): void { const p = thePanel; if (p != null) p.key(4); }

/**
 * A ready-made front panel: a status screen with the app's states, values and outputs, and a menu
 * (OK) to change settings and run commands with up/down buttons. Settings changed here are saved
 * and sent to ESP Lab. Hold OK (or press BACK) to go back; idle for 30 s returns to the status.
 *   new Panel(app, new Ssd1306(0x3c, 21, 22), app.button("up", 32), app.button("down", 33), app.button("ok", 25));
 */
export class Panel {
  screen: i32 = 0; // 0 status, 1 menu, 2 editing a setting, 3 message
  scroll: i32 = 0;
  cursor: i32 = 0;
  editValue: f64 = 0;
  step: f64 = 1;
  idleAt: i64 = 0;
  message: string = "";
  constructor(public app: App, public oled: Ssd1306, up: Input, down: Input, ok: Input, back: Input | null = null, public title: string = "") {
    thePanel = this;
    up.autoRepeat(150);
    down.autoRepeat(150);
    app.on(up.name + ".press", panelUp);
    app.on(up.name + ".repeat", panelUp);
    app.on(down.name + ".press", panelDown);
    app.on(down.name + ".repeat", panelDown);
    app.on(ok.name + ".press", panelOk);
    app.on(ok.name + ".long", panelBack);
    if (back != null) app.on(back.name + ".press", panelBack);
    app.every(500, panelTick);
  }
  private lines(): i32 { return (this.oled.height - 10) / 9; }
  private statusRows(): string[] {
    const a = this.app;
    const rows: string[] = [];
    for (let i = 0; i < a.machines.length; i++) rows.push(a.labelOf(a.machines[i].name) + "|" + a.labelOf(a.machines[i].state));
    for (let i = 0; i < a.sensors.length; i++) {
      const x = a.sensors[i];
      rows.push(a.labelOf(x.name) + "|" + shortNumber(x.value) + (x.unit.length && !isNaN(x.value) ? " " + x.unit : ""));
    }
    for (let i = 0; i < a.outputs.length; i++) rows.push(a.labelOf(a.outputs[i].name) + "|" + (a.outputs[i].isOn ? "ON" : "off"));
    return rows;
  }
  /** Menu entries: settings, then commands, then Back. */
  private menuCount(): i32 { return this.app.settings.length + this.app.commands.length + 1; }
  private menuRow(i: i32): string {
    const a = this.app;
    if (i < a.settings.length) {
      const x = a.settings[i];
      return a.labelOf(x.name) + "|" + shortNumber(x.value) + (x.unit.length ? " " + x.unit : "");
    }
    i -= a.settings.length;
    if (i < a.commands.length) return a.labelOf(a.commands[i].name) + "|>";
    return "Back|";
  }
  key(k: i32): void {
    this.idleAt = millis();
    const a = this.app;
    if (this.screen == 3) { this.screen = 1; this.draw(); return; }
    if (this.screen == 0) {
      const max = this.statusRows().length - this.lines();
      if (k == 1 && this.scroll > 0) this.scroll--;
      else if (k == 2 && this.scroll < max) this.scroll++;
      else if (k == 3) { this.screen = 1; this.cursor = 0; this.scroll = 0; }
    } else if (this.screen == 1) {
      const n = this.menuCount();
      if (k == 1) this.cursor = (this.cursor + n - 1) % n;
      else if (k == 2) this.cursor = (this.cursor + 1) % n;
      else if (k == 4) { this.screen = 0; this.scroll = 0; }
      else if (k == 3) {
        if (this.cursor < a.settings.length) {
          const x = a.settings[this.cursor];
          this.editValue = x.value;
          const range = x.max - x.min;
          this.step = range <= 2 ? 0.1 : range <= 20 ? 0.5 : range <= 200 ? 1 : range <= 2000 ? 10 : 100;
          this.screen = 2;
        } else if (this.cursor < a.settings.length + a.commands.length) {
          const c = a.commands[this.cursor - a.settings.length];
          const args = new Args();
          c.handler(args);
          this.message = args.error.length ? args.error : a.labelOf(c.name) + ": done";
          this.screen = 3;
        } else {
          this.screen = 0;
          this.scroll = 0;
        }
      }
    } else if (this.screen == 2) {
      const x = a.settings[this.cursor];
      if (k == 1) this.editValue = Math.min(x.max, Math.round((this.editValue + this.step) / this.step) * this.step);
      else if (k == 2) this.editValue = Math.max(x.min, Math.round((this.editValue - this.step) / this.step) * this.step);
      else if (k == 3) { a.setLocally(x, this.editValue); this.message = a.labelOf(x.name) + " saved"; this.screen = 3; }
      else if (k == 4) this.screen = 1;
    }
    this.draw();
  }
  tick(): void {
    if (this.screen != 0 && millis() - this.idleAt > 30000) { this.screen = 0; this.scroll = 0; }
    this.draw();
  }
  private header(text: string): void {
    this.oled.fillRect(0, 0, 128, 9);
    this.oled.text(2, 1, text, 1, false);
  }
  private row(i: i32, text: string, selected: bool): void {
    const y = 11 + i * 9;
    const cut = text.indexOf("|");
    const left = cut >= 0 ? text.substring(0, cut) : text;
    const right = cut >= 0 ? text.substring(cut + 1) : "";
    if (selected) this.oled.fillRect(0, y - 1, 128, 9);
    const room = 21 - right.length - (right.length ? 1 : 0);
    this.oled.text(1, y, left.length > room ? left.substring(0, room) : left, 1, !selected);
    if (right.length) this.oled.textRight(y, right, 1, 127, !selected);
  }
  draw(): void {
    const o = this.oled;
    const a = this.app;
    o.clear();
    if (this.screen == 0) {
      this.header(this.title.length ? this.title : a.labelOf(a.name));
      const rows = this.statusRows();
      for (let i = 0; i < this.lines() && this.scroll + i < rows.length; i++) this.row(i, rows[this.scroll + i], false);
    } else if (this.screen == 1) {
      this.header("Menu");
      const n = this.menuCount();
      const first = this.cursor < this.lines() ? 0 : this.cursor - this.lines() + 1;
      for (let i = 0; i < this.lines() && first + i < n; i++) this.row(i, this.menuRow(first + i), first + i == this.cursor);
    } else if (this.screen == 2) {
      const x = a.settings[this.cursor];
      this.header(a.labelOf(x.name));
      o.textCenter(o.height / 2 - 8, shortNumber(this.editValue) + (x.unit.length ? " " + x.unit : ""), 2);
      if (o.height >= 64) o.textCenter(o.height - 9, shortNumber(x.min) + " .. " + shortNumber(x.max), 1);
    } else {
      this.header(a.labelOf(a.name));
      o.textCenter(o.height / 2 - 4, this.message, 1);
    }
    o.show();
  }
}
`;
