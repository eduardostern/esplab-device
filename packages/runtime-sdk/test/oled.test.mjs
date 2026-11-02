// OLED display, buttons and the front panel through the scenario runner: the screen is read
// back as text, buttons are pressed with gpio levels at simulated times.
import { parseScenarioFile, runScenarios, SCENARIO_COMPILE_FLAGS } from '../src/index.ts';
import { build } from './compile.mjs';

const program = `
import { App, Args } from "lab";
import { Ssd1306, Panel } from "io";
import { analogRead } from "esp";
const app = new App("pool", "1.0.0");
app.label("pool", "Piscina");
function readWater(): f64 { return <f64>analogRead(34) / 4095.0 * 50.0; }
const water = app.sensor("water", "°C", readWater, 1000, 0.1);
app.label("water", "Agua");
const target = app.setting("target", "°C", 28, 10, 40);
app.label("target", "Alvo");
const pump = app.output("pump", 26);
let boosts = 0;
function boost(a: Args): void { boosts++; pump.on(); }
app.command("boost", boost);
const up = app.button("up", 32);
const down = app.button("down", 33);
const ok = app.button("ok", 25);
const panel = new Panel(app, new Ssd1306(0x3c, 21, 22), up, down, ok);
// Gestures, counted for the test.
let longs = 0, doubles = 0;
function onLong(): void { longs++; }
function onDouble(): void { doubles++; }
app.on("down.long", onLong);
down.doublePress(400);
app.on("down.double", onDouble);
function counts(): f64 { return <f64>(longs * 100 + doubles); }
app.sensor("gestures", "", counts, 200);
`;

// A press is the pin pulled low, then released.
const press = (pin, at, ms = 150) => [{ at, set: { [`gpio:${pin}`]: false } }, { at: at + ms / 1000, set: { [`gpio:${pin}`]: true } }];
const tests = {
  tests: [
    {
      name: 'status screen, menu, edit a setting, run a command',
      steps: [
        { at: 0, set: { 'adc:34': 2047, 'gpio:25': true, 'gpio:32': true, 'gpio:33': true } },
        { at: 3, expect: { 'display:0x3c': { contains: 'Piscina' } } },
        { at: 3.1, expect: { 'display:0x3c': { contains: 'Agua 25.0 °C' } } },
        { at: 3.2, expect: { 'display:0x3c': { contains: 'pump off' } } },
        ...press(25, 4),
        { at: 5, expect: { 'display:0x3c': { contains: 'Menu' } } },
        { at: 5.1, expect: { 'display:0x3c': { contains: 'Alvo 28.0 °C' } } },
        ...press(25, 6),
        { at: 7, expect: { 'display:0x3c': { contains: '28.0 °C' } } },
        ...press(32, 8), ...press(32, 8.5),
        { at: 9.5, expect: { 'display:0x3c': { contains: '30.0 °C' } } },
        ...press(25, 10),
        { at: 11, expect: { 'display:0x3c': { contains: 'Alvo saved' }, target: 30 } },
        ...press(25, 12),
        ...press(33, 13),
        ...press(25, 14),
        { at: 15, expect: { 'display:0x3c': { contains: 'boost: done' }, pump: true } },
        { at: 50, expect: { 'display:0x3c': { contains: 'pump ON' } } },
      ],
    },
    {
      name: 'button gestures: long press and double press',
      steps: [
        { at: 0, set: { 'gpio:25': true, 'gpio:32': true, 'gpio:33': true } },
        { at: 2, set: { 'gpio:33': false } },
        { at: 3.2, set: { 'gpio:33': true } },
        ...press(33, 5, 100), ...press(33, 5.3, 100),
        { at: 7, expect: { gestures: 101 } },
      ],
    },
  ],
};

const r = await build({ 'main.ts': program }, SCENARIO_COMPILE_FLAGS);
if (!r.ok) throw new Error(r.log);
let failed = 0;
for (const res of await runScenarios(r.wasm, parseScenarioFile(JSON.stringify(tests)))) {
  console.log(res.ok ? 'PASS' : 'FAIL', `oled: ${res.name}`);
  for (const f of res.failures) console.log(`     at ${f.at} s: ${f.key} expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`);
  if (res.error) console.log('     error:', res.error);
  if (!res.ok) failed++;
}
if (failed) process.exit(1);
