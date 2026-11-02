/**
 * What the AI (and the docs panel) needs to know to write ESP Lab Runtime programs.
 * Keep in sync with esp-lib.ts.
 */
export const RUNTIME_REFERENCE = `ESP Lab Runtime programs are AssemblyScript (a strict TypeScript subset compiled to WebAssembly).
The entry file is main.ts. Export setup() (runs once) and/or loop() (runs repeatedly), like Arduino.
Import the hardware API from "esp":

  import { pinMode, digitalWrite, digitalRead, analogRead, analogWrite, delay, delayMicroseconds,
           millis, micros, random, print, println, numText, parseNum, i2cBegin, i2cWrite, i2cRead,
           INPUT, OUTPUT, INPUT_PULLUP, INPUT_PULLDOWN, HIGH, LOW } from "esp";

  pinMode(pin: i32, mode: i32)        digitalWrite(pin: i32, value: i32)   digitalRead(pin: i32): i32
  analogRead(pin: i32): i32  (0..4095, ADC1 pins: ESP32 32-36,39; S3 1-10; C3 0-4)   analogWrite(pin: i32, duty: i32) (0..255 PWM)
  delay(ms: i32)   delayMicroseconds(us: i32)   millis(): i64   micros(): i64   random(max: i32): i32
  print(value)   println(value = "")   value: text, a number or a bool; numbers print whole, or
      print(x, decimals): println(t, 1) prints "25.5". Print parts one by one instead of joining
      strings: print("count "); println(n). That keeps a program a few hundred bytes.
  numText(v: f64, decimals: i32 = -1): string   parseNum(text: string): f64 (NaN if no number)
  i2cBegin(sda: i32, scl: i32, hz: i32): i32   i2cWrite(addr: i32, data: Uint8Array): i32
  i2cRead(addr: i32, length: i32): Uint8Array | null

AssemblyScript rules that differ from TypeScript:
- Numbers are typed: i32, u32, i64, f32, f64 (number = f64). Integer literals default to i32.
  millis() returns i64, so store it in an i64: let last: i64 = 0; if (millis() - last >= 1000) {...}
- Print numbers directly (println(n), println(x, 2)). For text use numText(x) / numText(x, 2); x.toFixed() is not available.
- No any, no union types except T | null, no closures that capture locals, no try/catch.
- Strings concatenate with +, but each + creates a string and brings in the memory manager (~3 KB). Arrays: Array<i32>, StaticArray<i32>, Uint8Array.
- Module-level let/const variables keep state between loop() calls.
- delay() lets the rest of the device run; avoid busy loops without delay().

Runtime behaviour:
- The program compiles to WebAssembly; the firmware's WAMR interpreter executes that bytecode on the device.
- The firmware prints "[vm] ready (N byte program, ...)" when a program starts.
- A crash prints "[vm] abort: <message> (<file>:<line>:<col>)" or "[vm] trap in loop(): <reason>" and stops the program.
- Programs get 64 KiB of memory when the device uses Wi-Fi and up to 128 KiB offline or on an
  ESP32-S3 with PSRAM (code is separate, up to 128 KiB; programs over 44 KiB get 64 KiB). One allocation must fit in 64 KiB. Avoid building big strings in loops.`;

/**
 * The lab framework: the recommended way to write device applications (controllers, automation).
 * Keep in sync with lab-lib.ts.
 */
export const LAB_REFERENCE = `The "lab" framework (import from "lab") is the preferred way to write device applications:
thermostats, pool/spa and solar controllers, generator auto-start, home automation, sensor nodes.
A program declares a device model and state machines at the top level of main.ts. It does NOT
export setup()/loop(): the framework runs an event loop. ESP Lab, apps and websites see the
model live (values, settings, commands, events, the machines' current state).

  import { analogRead } from "esp";
  import { App, Args, Hysteresis, Pid, scale, ntcCelsius, epochMs, loadText, saveText } from "lab";

  const app = new App("pool", "1.0.0");                         // exactly one
  const water  = app.sensor("waterTemp", "°C", readWater, 1000, 0.1); // read fn, every ms, report deadband
  const level  = app.value("level", "%");                       // set from code: level.set(42)
  const target = app.setting("target", "°C", 28, 10, 40);       // default, min, max; persisted; editable remotely
  const pump   = app.relay("pump", 26).minOff(5000);            // active-high output; .minOn(ms) .minOff(ms)
  const heater = app.relay("heater", 27).interlock(pump);       // only on while pump is on (drops with it)
  const alarm  = app.relay("alarm", 25, true).failsafe(true);   // activeLow; state if the program dies
  const door   = app.input("door", 4);                          // debounced; events "door.on" / "door.off"
  const go     = app.button("go", 0);                           // button to GND; "go.on" when pressed
  app.command("boost", startBoost);                             // handler(args: Args)
  app.event("overheat");                                        // declared events (optional)

  const mode = app.machine("mode", ["idle", "heating", "fault"]); // first state is the initial one
  mode.on("idle", "tick", isCold, "heating", "water < target");   // from, event, guard, to, label
  mode.on("heating", "tick", isWarm, "idle", "water >= target");
  mode.go("idle", "go.on", "heating");                            // no guard
  mode.any("sensorFault", "fault");                               // from any state
  mode.timeout("heating", 3600000, "fault");                      // max time in a state
  mode.enter("heating", heatOn);  mode.exit("heating", heatOff);
  mode.during("heating", keepWarm);                               // called every tick while heating

  function readWater(): f64 { return scale(analogRead(34), 0, 4095, 10, 40); }
  function isCold(): bool { return water.value < target.value - 0.5; }
  function startBoost(args: Args): void { mode.goto("heating", "command"); args.replyText("ok"); }

Events: "tick" runs every second and right after any value, setting, input or command changes,
so guards on "tick" react immediately. Input events: "<input>.on"/"<input>.off". app.emit("name"),
emitValue("name", v), emitText("name", s) send an event to ESP Lab and also drive machines/hooks.
app.on("boot" | "online" | "offline" | "config" | "tick" | any event, fn). app.every(ms, fn),
app.after(ms, fn), app.at("06:30", fn) with app.timezone(-180). Machine: m.state, m.is("x"),
m.elapsed (ms in state), m.goto("x"). Sensor: .value (NaN when unknown), .valid, .set(v).
Setting: .value, .set(v). Output: .on() .off() .toggle() .set(bool) .isOn. Input: .value.
Args: .number, .text, .num("key"), .str("key"), .reply(v), .replyText(s), .fail("why").
Handlers are top-level functions (no closures). Do not call delay() in lab programs.
Declare module-level variables (let x = ...) above the code and functions that use them: the
compiler rejects a variable used before its declaration line.
Outputs start off; relays never switch faster than their minOn/minOff allow; an interlocked output
turns off as soon as the output it needs turns off. On a trap all outputs go to their failsafe state.`;

/**
 * The io library: buses and drivers. Keep in sync with io-lib.ts.
 */
export const IO_REFERENCE = `The "io" library (import from "io") has buses and device drivers for lab programs:

  import { Serial, ModbusRtu, regsToFloat, regsToU32, regToI16, SERIAL_8N1, SERIAL_8E1,
           OneWire, Ds18b20, Ads1115, Ssd1306, Panel, shortNumber, Spi, LoRa, LoraNode, LoraGateway } from "io";

Serial ports (UART1/UART2; the ESP32-C3 has only port 1). dePin drives an RS-485 transceiver:
  const bus = new Serial(2, 9600, 17, 16, 4 /* DE pin, -1 if none */, SERIAL_8N1);
  bus.write(bytes)  bus.print("text")  bus.available()  bus.read(max, timeoutMs): Uint8Array
  bus.readExactly(n, timeoutMs)  bus.readLine(timeoutMs): string | null  bus.discard()

Modbus RTU master (energy meters, inverters, VFDs, sensors). Reads return null on failure; .error says why:
  const mb = new ModbusRtu(bus, 300 /* timeout ms */, 1 /* retries */);
  mb.readHolding(unit, address, count): Uint16Array | null   (function 3)
  mb.readInput(unit, address, count): Uint16Array | null     (function 4)
  mb.readCoils(unit, address, count, discrete = false): bool[] | null
  mb.writeRegister(unit, address, value): bool   mb.writeRegisters(unit, address, values: u16[]): bool
  mb.writeCoil(unit, address, on): bool
  regsToFloat(regs, i, swapWords = false): f64   regsToU32(regs, i)   regToI16(regs, i)
  function power(): f64 { const r = mb.readInput(1, 0x0c, 2); return r == null ? NaN : regsToFloat(r, 0); }
  app.sensor("power", "W", power, 5000);

DS18B20 probes on one 1-Wire GPIO (4.7k pull-up). celsius(i) never blocks (background conversion):
  const probes = new Ds18b20(15);   probes.count   probes.celsius(0)   (NaN when not readable)
  function water(): f64 { return probes.celsius(0); }   app.sensor("water", "°C", water, 2000, 0.1);
OneWire for other 1-Wire chips: reset(), write(b), read(), skip(), select(rom), search(): Uint8Array[].

SPI (one bus, up to 3 devices): Spi.begin(sclk, mosi, miso); const dev = new Spi(cs, hz, mode);
dev.transfer(bytes) sends the bytes and replaces them with the bytes read.

LoRa (SX1276/77/78, RFM95). TTGO LoRa32 / Heltec pins: SCK 5, MISO 19, MOSI 27, NSS 18, RST 14, DIO0 26:
  const radio = new LoRa(5, 19, 27, 18, 14, 26);
  radio.begin(915e6 /* 868e6 EU, 433e6 */, 9 /* SF 7..12 */, 125000 /* bandwidth */, 5 /* 4/5 */, 17 /* dBm */);
  radio.send(bytes)   radio.available(): bool -> radio.packet, radio.rssi, radio.snr

LoRa nodes and gateways (the easy way): a node's whole lab app (values, events, commands,
settings) travels over LoRa to a gateway, and the node appears in ESP Lab as its own device.
Packets are signed with the network key (same on both); long frames are split automatically.
  // node (battery sensor, remote pump):          // gateway (on Wi-Fi):
  const link = new LoraNode(radio, "my-network-key");   const gw = new LoraGateway(app, radio, "my-network-key");
The node needs no Wi-Fi. gw.nodes counts nodes heard; nodes silent for 10 minutes show offline.
LoRa is slow (SF9: ~0.2 s per small packet): report with deadbands and avoid frequent values.

KinCony KC868-A6 (relays and inputs on PCF8574 I2C expanders, not GPIOs):
  const board = new Kc868a6();
  const pump = board.relay(app, "pump", 1);          // R1..R6 as lab outputs (interlock, minOff, failsafe work)
  const flow = board.input(app, "flow", 1);          // IN1..IN6, "on" while the contact is closed to GND
  const bus = board.rs485(9600);                     // RS-485 (TX 27, RX 14, automatic direction)
  Kc868a6.ONEWIRE_1 (GPIO 32), ONEWIRE_2 (33) for DS18B20; Kc868a6.volts(Kc868a6.AI1) for the 0-5 V inputs.
I2C port expanders on any board (import from "lab"): const x = new Pcf8574(0x20, sda, scl) (8 pins; PCF8574A
is 0x38-0x3F) or new Pcf8575(0x20, sda, scl) (16 pins: 0-7 = P00-P07, 8-15 = P10-P17); then
app.relayAt("valve", x, 0, true, "K1"); app.inputAt("door", x, 4). Inputs are pins left high with a switch
to GND (activeLow true). Expander pins sink current well but source only ~0.1 mA: drive LEDs and relay modules
active low (LED from 3V3 through a resistor into the pin). If the program stops, the firmware writes the
outputs' failsafe states to the expander. Address = 0x20 + A2A1A0 (pins to GND = 0, to 3V3 = 1).
ADS1115 16-bit ADC (import from "io"): const adc = new Ads1115(0x48, sda, scl);  adc.volts(0..3) against GND,
adc.diff(0, 1) differential, adc.gain(2.048) for a smaller full scale (6.144 4.096 2.048 1.024 0.512 0.256 V).
Linear and accurate, unlike the ESP32 ADC: use it for thermistors, current shunts, pressure sensors. NaN = read
failed (adc.ok false). An NTC on it: ntcCelsius-style maths on the volts, e.g. R = 10000 * v / (3.3 - v).
I2C pins: DevKit SDA 21 / SCL 22; ESP32-C3 SuperMini SDA 6 / SCL 7 (its 8/9 share the LED and BOOT button). Any
free GPIOs work; 4.7k pull-ups to 3V3 (most breakout modules have them). Several chips share the two wires.

OLED display (the 0.96" SSD1306 128x64 I2C module, or the 1.3" SH1106): const oled = new Ssd1306(0x3c, sda, scl)
(height 32 for 128x32 modules; 5th argument true for SH1106). Draw then call oled.show(): oled.clear();
oled.text(0, 0, "Pool", 2); oled.text(0, 20, "Water " + shortNumber(water.value) + " °C"); oled.bar(0, 40, 128, 10, 0.6);
textRight / textCenter, line, rect, fillRect, pixel, invert, contrast. 5x7 font: 21 characters x 8 lines at size 1
(accents are drawn without them; ° works). Redraw from app.every(500, draw) or on events, not in a busy loop.
Buttons: app.button(name, pin) (to GND) fires "<name>.on"/".off" and gestures: "<name>.press" (short press),
"<name>.long" (held 800 ms), ".repeat" while held with .autoRepeat(150), ".double" with .doublePress(400).
Use them as machine events (m.on("idle", "ok.press", always, "menu")) or app.on("up.press", fn).
app.buttonAt(name, expander, bit) for buttons on a PCF8574/PCF8575.
Front panel in one line: new Panel(app, oled, app.button("up", 32), app.button("down", 33), app.button("ok", 25))
shows a status screen (machine states, values, outputs) and an OK menu to edit settings (saved and sent to ESP Lab)
and run commands; hold OK to go back. Labels from app.label() are what it shows.

Pentair IntelliFlo on RS-485: const p = new PentairPump(bus, 0x60); call p.set(rpm) each tick (0 stops;
it repeats every 10 s, as the pump needs); p.watts and p.reportedRpm come from the pump.
VFDs with the Inovance MD380 register map (most Chinese vector drives: "9600 series", manuals with groups
P0-PE/A0-AC/U0): const vfd = new Md380Drive(new ModbusRtu(bus, 300, 1), 1, 50).min(25); call vfd.run(hz) each tick
(0 = ramp stop; it repeats every 2 s); vfd.hz, vfd.amps, vfd.watts, vfd.fault (Err n, 0 none), vfd.reset().
On the drive: P0-02=2, P0-03=9, PD-00=5 (9600), PD-01=3 (8N1), PD-02=address, PD-05=31, PD-04=3.0 (stop if silent).
AquaCal heat pumps (five-button display, External Control Mode = SMART) and Pentair UltraTemp on the same
RS-485 bus: const hp = new PentairHeatPump(bus, 112); call hp.heat() / hp.cool() / hp.off() each tick (it
repeats every 5 s). There is no setpoint on the bus: the program calls for heat while the water is below its
setpoint (with hysteresis). hp.status (0 off, 1 heating, 2 cooling, -1 no answer), hp.online.
Pumps without RS-485 (Black+Decker, most Vevor): switch them with a relay, set the speed on the pump.
The "Pool & spa controller" template (KC868-A6) is a complete example of all of this.

Pins: the flash pins (ESP32 6-11, ESP32-S3 26-32 (+33-37 with octal PSRAM), ESP32-C3 12-17) are refused.`;
