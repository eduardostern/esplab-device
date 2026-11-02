/**
 * The firmware's message and frame functions (runtime 0.13+, firmware/esplab-runtime/main/
 * labhost.c) for JS hosts: the scenario runner and the test device. Programs hand a received
 * frame to msgLoad and read its fields; they build outgoing frames with jBegin ... jSend.
 */
import { formatNumber } from './numfmt';

type Value = null | boolean | number | string | Value[] | { [key: string]: Value };

const TYPES: Record<string, number> = { cmd: 1, cfg: 2, time: 3, sync: 4, evt: 5, sub: 6 };

/** A number in a frame: null when not finite, whole numbers as integers, others to 3 decimals. */
export function jsonNumber(v: number): string {
  if (!Number.isFinite(v)) return 'null';
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return formatNumber(v, -1);
  return formatNumber(Math.floor(v * 1000 + 0.5) / 1000, -1);
}

function escape(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (ch === '"' || ch === '\\') out += `\\${ch}`;
    else if (c === 10) out += '\\n';
    else if (c < 32) out += ' ';
    else out += ch;
  }
  return out;
}

export function jsonImports(host: {
  mem: () => Uint8Array;
  str16: (ptr: number, bytes: number) => string;
  sendFrame: (text: string) => void;
  print: (text: string) => void;
}) {
  let msg: Value = null;
  let frame = '';
  let bad = false;
  const write16 = (text: string, out: number, cap: number) => {
    if (text.length * 2 > cap) return -1;
    const view = new DataView(host.mem().buffer);
    for (let i = 0; i < text.length; i++) view.setUint16(out + i * 2, text.charCodeAt(i), true);
    return text.length * 2;
  };
  const node = (k: number, kb: number, s: number, sb: number): Value | undefined => {
    const key = host.str16(k, kb);
    const sub = host.str16(s, sb);
    let n: Value | undefined = msg;
    if (n !== undefined && key) n = n !== null && typeof n === 'object' && !Array.isArray(n) ? n[key] : undefined;
    if (n !== undefined && sub) n = n !== null && typeof n === 'object' && !Array.isArray(n) ? n[sub] : undefined;
    return n;
  };
  const put = (text: string) => {
    if (bad) return;
    if (frame.length + text.length > 32767) { bad = true; return; }
    frame += text;
  };
  return {
    msgLoad(ptr: number, bytes: number, utf16: number) {
      const text = utf16 ? host.str16(ptr, bytes) : new TextDecoder().decode(host.mem().slice(ptr, ptr + bytes));
      try { msg = JSON.parse(text) as Value; } catch { msg = null; }
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return 0;
      const t = msg.t;
      return typeof t === 'string' ? TYPES[t] ?? 0 : 0;
    },
    msgNum(k: number, kb: number, s: number, sb: number) {
      const n = node(k, kb, s, sb);
      return typeof n === 'number' ? n : typeof n === 'boolean' ? (n ? 1 : 0) : NaN;
    },
    msgStr(k: number, kb: number, s: number, sb: number, out: number, cap: number) {
      const n = node(k, kb, s, sb);
      return typeof n === 'string' ? write16(n, out, cap) : -1;
    },
    msgKind(k: number, kb: number, s: number, sb: number) {
      const n = node(k, kb, s, sb);
      if (n === undefined) return 0;
      if (n === null) return 1;
      if (typeof n === 'boolean') return 2;
      if (typeof n === 'number') return 3;
      if (typeof n === 'string') return 4;
      return Array.isArray(n) ? 6 : 5;
    },
    msgKey(k: number, kb: number, index: number, out: number, cap: number) {
      const n = node(k, kb, 0, 0);
      if (n === null || n === undefined || typeof n !== 'object' || Array.isArray(n)) return -1;
      const key = Object.keys(n)[index];
      return key === undefined ? -1 : write16(key, out, cap);
    },
    jBegin() { frame = ''; bad = false; },
    jCh(c: number) { put(String.fromCharCode(c)); },
    jRaw(ptr: number, bytes: number) { put(host.str16(ptr, bytes)); },
    jStr(ptr: number, bytes: number) { put(`"${escape(host.str16(ptr, bytes))}"`); },
    jKey(ptr: number, bytes: number, first: number) { put(`${first ? '' : ','}"${escape(host.str16(ptr, bytes))}":`); },
    jNum(v: number) { put(jsonNumber(v)); },
    jMsg(k: number, kb: number) { const n = node(k, kb, 0, 0); put(n === undefined ? 'null' : JSON.stringify(n)); },
    jSend() {
      if (bad) { host.print('[lab] frame too large, dropped\n'); return; }
      if (frame.length) host.sendFrame(frame);
    },
    jTake(out: number, cap: number) { return bad ? -1 : write16(frame, out, cap); },
  };
}
