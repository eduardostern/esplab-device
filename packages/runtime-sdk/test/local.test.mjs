// Local control: settings changed on the device's local page while the cloud is unreachable are
// kept across a restart, reported to the hub first (cfglocal, pendingCfg in hello) and cleared
// once the hub confirms them; the clock quality from the firmware reaches the hello frame.
import { build } from './compile.mjs';
import { Device, msg, net } from './sim.mjs';

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
const r = await build({ 'main.ts': `
import { App } from "lab";
const app = new App("pool", "1.0.0");
const target = app.setting("target", "°C", 28, 10, 40);
const other = app.setting("other", "", 1, 0, 5);
` }, ['--exportStart', '_start']);
if (!r.ok) throw new Error(r.log);
const idle = (n) => Array.from({ length: n }, () => () => null);
const hellos = (d) => d.frames().filter((f) => f.t === 'hello');
const locals = (d) => d.frames().filter((f) => f.t === 'cfglocal');

// 1. Offline: the owner changes the target on the local page.
const first = new Device({ script: [...idle(2), () => msg({ t: 'cfg', local: true, v: { target: 31 } }), ...idle(2)] });
await first.run(r.wasm);
check('local change applies at once', first.frames().some((f) => f.t === 'state' && f.v.target === 31));
check('local change is reported as cfglocal (no version claimed)', locals(first).at(-1)?.v.target === 31 && !first.frames().some((f) => f.t === 'cfgack'));
check('only the changed setting is reported', locals(first).at(-1) && !('other' in locals(first).at(-1).v), JSON.stringify(locals(first).at(-1)));

// 2. Restart (same NVS), clock restored as approximate, then the cloud comes back.
const second = new Device({ kv: first.kv, script: [...idle(1), () => net(true, true, 1), ...idle(1), () => msg({ t: 'cfg', ver: 7, v: { target: 31, other: 1 } }), ...idle(1), () => net(true, true, 2), ...idle(1)] });
await second.run(r.wasm);
const h = hellos(second);
check('the setting survives the restart', h[0] && second.frames().some((f) => f.t === 'state' && f.v.target === 31));
check('hello says settings are pending, and cfglocal follows it', h[0]?.pendingCfg === true && locals(second).length >= 1);
check('hello carries the clock quality', h.some((x) => x.clock === 1), h.map((x) => x.clock).join(','));
check('the hub confirmation clears the pending settings', second.kv.get('cfglocal') === '' && second.frames().some((f) => f.t === 'cfgack' && f.ver === 7));

// 3. Next restart: nothing pending any more.
const third = new Device({ kv: second.kv, script: [...idle(2)] });
await third.run(r.wasm);
check('after confirmation nothing is pending', hellos(third)[0] && hellos(third)[0].pendingCfg === undefined && locals(third).length === 0);

const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
