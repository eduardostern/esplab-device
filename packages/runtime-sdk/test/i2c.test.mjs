// I2C modules through the scenario runner: PCF8574 and PCF8575 expanders (relays, inputs) and
// an ADS1115 ADC (single-ended, differential, gain), compiled with the real compiler.
import { parseScenarioFile, runScenarios, SCENARIO_COMPILE_FLAGS } from '../src/index.ts';
import { build } from './compile.mjs';

const program = `
import { App, Pcf8574, Pcf8575 } from "lab";
import { Ads1115 } from "io";
const app = new App("i2c-demo", "1.0.0");
const x8 = new Pcf8574(0x20, 21, 22);
const x16 = new Pcf8575(0x21, 21, 22);
const adc = new Ads1115(0x48, 21, 22);
const fine = new Ads1115(0x49, 21, 22).gain(0.256);
const fan = app.relayAt("fan", x8, 0);            // P0, active low
const valve = app.relayAt("valve", x16, 12);      // P14
const lamp = app.relayAt("lamp", x16, 3, false);  // P03, active high
const door = app.inputAt("door", x16, 9);         // P11 to GND when closed
const button = app.inputAt("button", x8, 5);      // P5
function v0(): f64 { return adc.volts(0); }
function d01(): f64 { return adc.diff(0, 1); }
function shunt(): f64 { return fine.diff(2, 3) * 1000; }
const a0 = app.sensor("a0", "V", v0, 1000, 0.001);
app.sensor("d01", "V", d01, 1000, 0.001);
app.sensor("shunt", "mV", shunt, 1000, 0.01);
function control(): void {
  fan.set(a0.value > 2.0);
  valve.set(door.value);
  lamp.set(button.value);
}
app.every(500, control);
`;

const tests = {
  tests: [
    {
      name: 'expanders and ADC',
      steps: [
        { at: 0, set: { 'ads1115:0x48:0': 1.0, 'ads1115:0x48:1': 0.25, 'ads1115:0x49:2': 0.105, 'ads1115:0x49:3': 0.1 } },
        { at: 3, expect: { a0: 1.0, d01: 0.75, shunt: 5, fan: false, 'pcf:0x20:0': true, valve: false, 'pcf:0x21:12': true, lamp: false, 'pcf:0x21:3': false } },
        { at: 4, set: { 'ads1115:0x48:0': 2.5, 'pcf:0x21:9': false, 'pcf:0x20:5': false } },
        { at: 7, expect: { a0: 2.5, fan: true, 'pcf:0x20:0': false, door: true, valve: true, 'pcf:0x21:12': false, button: true, lamp: true, 'pcf:0x21:3': true, 'pcf:0x21:11': true } },
        { at: 8, set: { 'pcf:0x21:9': true } },
        { at: 10, expect: { door: false, valve: false, 'pcf:0x21:12': true } },
      ],
    },
  ],
};

const r = await build({ 'main.ts': program }, SCENARIO_COMPILE_FLAGS);
if (!r.ok) throw new Error(r.log);
let failed = 0;
for (const res of await runScenarios(r.wasm, parseScenarioFile(JSON.stringify(tests)))) {
  console.log(res.ok ? 'PASS' : 'FAIL', `i2c: ${res.name}`);
  for (const f of res.failures) console.log(`     at ${f.at} s: ${f.key} expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`);
  if (res.error) console.log('     error:', res.error);
  if (!res.ok) failed++;
}
if (failed) process.exit(1);
