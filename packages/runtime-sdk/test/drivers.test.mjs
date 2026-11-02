// Runs real "lab"/"io" programs (compiled with the real compiler) against simulated hardware.
// npm test -w @esp/runtime-sdk
// Hardware: a Modbus meter on RS-485, DS18B20 probes on 1-Wire, SX127x radios (node <-> gateway).
import crypto from 'node:crypto';
import { build } from './compile.mjs';
import { Device, ModbusSlave, OneWireBus, romFor, Sx127x, msg, gpio } from './sim.mjs';

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
const compiled = async (src) => {
  const r = await build({ 'main.ts': src }, ['--exportStart', '_start']);
  if (!r.ok) throw new Error(r.log);
  return r.wasm;
};
const idle = (n) => Array.from({ length: n }, () => () => null);
const seen = (dev, key, value) => dev.frames().some((f) => f.t === 'state' && f.v[key] === value);
const states = (dev) => Object.assign({}, ...dev.frames().filter((f) => f.t === 'state').map((f) => f.v));

// ---- Modbus RTU ----------------------------------------------------------------------------
{
  const wasm = await compiled(`
import { App, Args } from "lab";
import { Serial, ModbusRtu, regsToFloat, regToI16 } from "io";
const app = new App("meter");
const bus = new Serial(2, 9600, 17, 16, 4);
const mb = new ModbusRtu(bus, 200, 1);
function power(): f64 { const r = mb.readInput(1, 0x0c, 2); return r == null ? NaN : regsToFloat(r, 0); }
function temp(): f64 { const r = mb.readHolding(1, 0x100, 1); return r == null ? NaN : <f64>regToI16(r, 0) / 10; }
let lastError = "";
function missing(): f64 { const r = mb.readHolding(1, 0x999, 1); lastError = mb.error; return r == null ? -1 : 1; }
function setSpeed(a: Args): void { if (!mb.writeRegister(1, 0x200, <i32>a.number)) a.fail(mb.error); }
function writeMany(a: Args): void { const v: u16[] = [7, 8, 9]; if (!mb.writeRegisters(1, 0x300, v)) a.fail(mb.error); }
function relay(a: Args): void { if (!mb.writeCoil(1, 5, a.number > 0)) a.fail(mb.error); }
function err(a: Args): void { a.replyText(lastError); }
app.sensor("power", "W", power, 1000);
app.sensor("temp", "C", temp, 1000);
app.sensor("missing", "", missing, 1000);
app.command("speed", setSpeed);
app.command("many", writeMany);
app.command("relay", relay);
app.command("err", err);
`);
  const f32 = Buffer.alloc(4); f32.writeFloatBE(1234.5);
  const slave = new ModbusSlave(1, { input: { 0x0c: f32.readUInt16BE(0), 0x0d: f32.readUInt16BE(2) }, holding: { 0x100: 0xffec /* -2.0 C */ } });
  const dev = new Device({
    hardware: { uart: slave },
    script: [
      ...idle(2),
      () => { slave.corruptNext = true; return null; }, // next reply has a bad CRC: retried
      ...idle(2),
      () => msg({ t: 'cmd', id: 'c1', n: 'speed', v: 1500 }),
      () => msg({ t: 'cmd', id: 'c2', n: 'many' }),
      () => msg({ t: 'cmd', id: 'c3', n: 'relay', v: 1 }),
      () => msg({ t: 'cmd', id: 'c4', n: 'err' }),
      () => { slave.silent = true; return null; },
      () => msg({ t: 'cmd', id: 'c5', n: 'speed', v: 1 }),
      ...idle(1),
    ],
  });
  await dev.run(wasm);
  const s = states(dev);
  const acks = Object.fromEntries(dev.frames().filter((f) => f.t === 'ack').map((f) => [f.id, f]));
  check('modbus float from input registers', seen(dev, 'power', 1234.5));
  check('modbus signed holding register', seen(dev, 'temp', -2));
  check('modbus meter silent -> value becomes null', s.power === null);
  check('modbus exception reported', s.missing === -1 && acks.c4?.v === 'exception 2', JSON.stringify(acks.c4));
  check('modbus write single register (fc6)', acks.c1?.ok && slave.holding[0x200] === 1500);
  check('modbus write multiple (fc16)', acks.c2?.ok && slave.holding[0x300] === 7 && slave.holding[0x302] === 9);
  check('modbus write coil (fc5)', acks.c3?.ok && slave.coils[5] === true);
  check('modbus timeout -> command fails', acks.c5 && !acks.c5.ok && acks.c5.err === 'no reply', JSON.stringify(acks.c5));
  const crcRetry = slave.requests.filter((r) => r[1] === 4).length > slave.requests.filter((r) => r[1] === 3 && r[2] === 1).length;
  check('modbus bad CRC is retried', crcRetry);
}

// ---- DS18B20 --------------------------------------------------------------------------------
{
  const wasm = await compiled(`
import { App } from "lab";
import { Ds18b20 } from "io";
const app = new App("probes");
const probes = new Ds18b20(15);
function a(): f64 { return probes.celsius(0); }
function b(): f64 { return probes.celsius(1); }
function n(): f64 { return <f64>probes.count; }
app.sensor("a", "C", a, 2000);
app.sensor("b", "C", b, 2000);
app.sensor("count", "", n, 2000);
`);
  const p1 = { rom: romFor([1, 2, 3, 4, 5, 6]), celsius: 21.5 };
  const p2 = { rom: romFor([1, 2, 3, 4, 5, 9]), celsius: -10.25 };
  const other = { rom: (() => { const r = [0x10, 9, 9, 9, 9, 9, 9]; let crc = 0; for (let b of r) for (let i = 0; i < 8; i++) { const m = (crc ^ b) & 1; crc >>= 1; if (m) crc ^= 0x8c; b >>= 1; } return [...r, crc]; })(), celsius: 99 };
  const bus = new OneWireBus([p1, p2, other]);
  const dev = new Device({ hardware: { ow: bus }, script: [...idle(3), () => { p1.celsius = 22.0; p2.corrupt = true; return null; }, ...idle(4)] });
  await dev.run(wasm);
  const frames = dev.frames().filter((f) => f.t === 'state');
  const first = Object.assign({}, ...frames.slice(0, 2).map((f) => f.v));
  const last = states(dev);
  check('1-Wire search finds both DS18B20s (skips other families)', last.count === 2, `count=${last.count}`);
  check('DS18B20 temperatures', seen(dev, 'a', 21.5) && seen(dev, 'b', -10.25));
  check('DS18B20 bad CRC -> no reading, update on the other', last.a === 22 && last.b === null, JSON.stringify({ a: last.a, b: last.b }));
}

// ---- LoRa: node -> gateway -> hub, and back ------------------------------------------------
{
  const KEY = 'network-key-123';
  const nodeSrc = `
import { App, Args } from "lab";
import { LoRa, LoraNode } from "io";
const app = new App("soil", "1.0.0");
const radio = new LoRa(5, 19, 27, 18, 14, 26);
radio.begin(915e6, 9);
const link = new LoraNode(radio, "${KEY}");
const moisture = app.value("moisture", "%");
let pumpOn = false;
function pump(a: Args): void { pumpOn = a.number > 0; a.reply(pumpOn ? 1 : 0); }
app.command("pump", pump);
app.every(1000, sample);
function sample(): void { moisture.set(42.5); }
`;
  const gwSrc = `
import { App } from "lab";
import { LoRa, LoraGateway } from "io";
const app = new App("gateway");
const radio = new LoRa(5, 19, 27, 18, 14, 26);
radio.begin(915e6, 9);
const gw = new LoraGateway(app, radio, "${KEY}", 5000);
function nodes(): f64 { return <f64>gw.nodes; }
app.sensor("nodes", "", nodes, 1000);
`;
  const nodeWasm = await compiled(nodeSrc);
  const gwWasm = await compiled(gwSrc);

  // 1. The node boots: its hello (with manifest) and values go out over the radio.
  const nodeRadio = new Sx127x();
  const node = new Device({ id: 'esp32-0000000000a1', hardware: { radio: nodeRadio }, script: idle(3) });
  await node.run(nodeWasm);
  check('node sends nothing over Wi-Fi', node.sent.length === 0);
  const uplink = nodeRadio.sentPackets;
  check('node frames go out as LoRa packets (hello is split)', uplink.length >= 3 && uplink.every((p) => p.length <= 255 && p[0] === 0xe5), `${uplink.length} packets, sizes ${uplink.map((p) => p.length).join(',')}`);

  // 2. The gateway hears them (plus a forged and a replayed packet) and forwards to the hub.
  const gwRadio = new Sx127x();
  const forged = Buffer.from(uplink[uplink.length - 1]); forged[12] ^= 0x20;
  const air = [...uplink, forged, uplink[uplink.length - 1]];
  const gw = new Device({
    id: 'esp32-00000000gw01',
    hardware: { radio: gwRadio },
    script: [
      ...air.map((p) => () => { gwRadio.deliver(p); return gpio(26); }),
      () => msg({ t: 'sub', id: 'esp32-0000000000a1', f: { t: 'cmd', id: 'k1', n: 'pump', v: 1 } }),
      ...idle(2),
    ],
  });
  await gw.run(gwWasm);
  const subs = gw.frames().filter((f) => f.t === 'sub');
  const hello = subs.find((f) => f.f.t === 'hello');
  check('gateway forwards the node hello with its manifest', hello?.id === 'esp32-0000000000a1' && hello.f.m.app === 'soil' && hello.f.m.commands[0] === 'pump', JSON.stringify(hello?.f.m)?.slice(0, 80));
  const values = subs.filter((f) => f.f.t === 'state');
  check('gateway forwards values with RSSI', values.some((f) => f.f.v.moisture === 42.5) && typeof values[0].rssi === 'number', JSON.stringify(values[0]));
  const messages = uplink.filter((p) => (p[10] >> 4) === 0).length;
  check('forged and replayed packets dropped', subs.length === messages, `forwarded ${subs.length} frames for ${messages} messages`);
  const gwState = states(gw);
  check('gateway counts its nodes', gwState.nodes === 1, `nodes=${gwState.nodes}`);
  const downlink = gwRadio.sentPackets;
  check('command for the node goes out as a downlink packet', downlink.length === 1 && (downlink[0][1] & 1) === 1);

  // 3. The node receives the command, runs it, and answers over the radio.
  const nodeRadio2 = new Sx127x();
  const node2 = new Device({
    id: 'esp32-0000000000a1',
    hardware: { radio: nodeRadio2 },
    script: [() => { nodeRadio2.deliver(downlink[0]); return gpio(26); }, ...idle(1)],
  });
  await node2.run(nodeWasm);
  // Decode the node's packets (a reference implementation of the link format).
  const decode = (p) => {
    const n = p.length - 4;
    const mic = crypto.createHmac('sha256', KEY).update(p.subarray(0, n)).digest().subarray(0, 4);
    return { ok: mic.equals(p.subarray(n)), frag: p[10], data: p.subarray(11, n).toString() };
  };
  const answers = nodeRadio2.sentPackets.map(decode).filter((d) => d.ok && d.frag === 0x01).map((d) => JSON.parse(d.data));
  const ack = answers.find((f) => f.t === 'ack');
  check('node runs the command and acks over LoRa', ack?.id === 'k1' && ack.ok && ack.v === 1, JSON.stringify(ack));

  // 4. A gateway that does not know a node asks it for its hello.
  const gwRadio2 = new Sx127x();
  const valueOnly = uplink[uplink.length - 1];
  const gw2 = new Device({ id: 'esp32-00000000gw02', hardware: { radio: gwRadio2 }, script: [() => { gwRadio2.deliver(valueOnly); return gpio(26); }, ...idle(1)] });
  await gw2.run(gwWasm);
  const asked = gwRadio2.sentPackets.map(decode);
  check('unknown node is asked to sync', asked.length === 1 && asked[0].data === '{"t":"sync"}' && gw2.frames().filter((f) => f.t === 'sub').length === 0);

  // 5. A silent node is reported offline.
  const gwRadio3 = new Sx127x();
  const gw3 = new Device({ id: 'esp32-00000000gw03', hardware: { radio: gwRadio3 }, script: [...uplink.map((p) => () => { gwRadio3.deliver(p); return gpio(26); }), ...idle(80)] });
  await gw3.run(gwWasm);
  check('silent node -> bye', gw3.frames().some((f) => f.t === 'sub' && f.f.t === 'bye'));
}

// ---- LoRa: a hello that needs several packets ---------------------------------------------
{
  const KEY = 'network-key-123';
  const sensors = Array.from({ length: 24 }, (_, i) => `app.value("soilMoistureZone${i}", "%");`).join('\n');
  const nodeWasm = await compiled(`import { App } from "lab";\nimport { LoRa, LoraNode } from "io";\nconst app = new App("irrigation", "2.0.0");\nconst radio = new LoRa(5, 19, 27, 18, 14, 26);\nradio.begin(868e6);\nconst link = new LoraNode(radio, "${KEY}");\n${sensors}\n`);
  const gwWasm = await compiled(`import { App } from "lab";\nimport { LoRa, LoraGateway } from "io";\nconst app = new App("gateway");\nconst radio = new LoRa(5, 19, 27, 18, 14, 26);\nradio.begin(868e6);\nconst gw = new LoraGateway(app, radio, "${KEY}");\n`);
  const r = new Sx127x();
  await new Device({ id: 'esp32-0000000000b2', hardware: { radio: r }, script: idle(1) }).run(nodeWasm);
  const firstSeq = r.sentPackets[0].readUInt16LE(8);
  const hello = r.sentPackets.filter((p) => p.readUInt16LE(8) === firstSeq);
  check('big hello is split into fragments', hello.length >= 3, `${hello.length} fragments`);
  const run = async (packets) => {
    const g = new Sx127x();
    const gw = new Device({ id: 'esp32-00000000gw09', hardware: { radio: g }, script: [...packets.map((p) => () => { g.deliver(p); return gpio(26); }), ...idle(1)] });
    await gw.run(gwWasm);
    return gw.frames().filter((f) => f.t === 'sub' && f.f.t === 'hello');
  };
  const whole = await run([...hello].reverse()); // out of order is fine
  check('gateway reassembles the fragments (any order)', whole.length === 1 && whole[0].f.m.sensors.length === 24);
  const missing = await run(hello.slice(1));
  check('a lost fragment drops the message', missing.length === 0);
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exitCode = results.every(Boolean) ? 0 : 1;
