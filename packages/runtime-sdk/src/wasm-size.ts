/**
 * What a compiled program is made of: section sizes and per-function code sizes, with each
 * function attributed to the user's code or to the runtime and libraries. The device runs this
 * module as it is: WAMR's classic interpreter executes the bytecode directly.
 *
 * The binary carries no names (programs ship without a name section), so names come from the
 * text format of the same compile: functions appear there in the binary's index order.
 */

export interface WasmFunctionSize {
  name: string;
  bytes: number;
  /** From the project's files (not ~lib: the AssemblyScript runtime, esp, lab and io). */
  user: boolean;
}

export interface WasmSizeReport {
  total: number;
  sections: Array<{ name: string; bytes: number }>;
  /** Code bytes of the user's functions, and of runtime and library functions. */
  userCode: number;
  runtimeCode: number;
  /** Static data (string literals, tables). */
  data: number;
  /** Largest first; only when the text format was available for names. */
  functions: WasmFunctionSize[];
}

const SECTION_NAMES = ['custom', 'type', 'import', 'function', 'table', 'memory', 'global', 'export', 'start', 'element', 'code', 'data', 'data count'];

function leb(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  let shift = 0;
  let i = at;
  for (;;) {
    const b = bytes[i++];
    value += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [value, i];
}

/** Function names from the text format, in definition order (imports excluded). */
function functionNames(wat: string): string[] {
  const names: string[] = [];
  for (const match of wat.matchAll(/^\s*\(func \$(\S+)/gm)) names.push(match[1]);
  return names;
}

function isUser(name: string): boolean {
  return !name.startsWith('~lib/') && !name.startsWith('~start') && !name.startsWith('~');
}

export function wasmSizeReport(wasm: Uint8Array, wat?: string): WasmSizeReport {
  const sections: Array<{ name: string; bytes: number }> = [];
  const bodies: number[] = [];
  let data = 0;
  let at = 8; // magic + version
  while (at < wasm.length) {
    const id = wasm[at];
    const [size, start] = leb(wasm, at + 1);
    const end = start + size;
    sections.push({ name: SECTION_NAMES[id] ?? `section ${id}`, bytes: end - at });
    if (id === 10) {
      let [count, p] = leb(wasm, start);
      for (; count > 0; count--) {
        const [bodySize, bodyStart] = leb(wasm, p);
        bodies.push(bodyStart + bodySize - p);
        p = bodyStart + bodySize;
      }
    }
    if (id === 11) data = end - at;
    at = end;
  }
  const names = wat ? functionNames(wat) : [];
  const functions: WasmFunctionSize[] = [];
  let userCode = 0;
  let runtimeCode = 0;
  bodies.forEach((bytes, i) => {
    const name = names.length === bodies.length ? names[i] : `function ${i}`;
    const user = names.length === bodies.length ? isUser(name) : false;
    if (user) userCode += bytes;
    else runtimeCode += bytes;
    functions.push({ name, bytes, user });
  });
  functions.sort((a, b) => b.bytes - a.bytes);
  return { total: wasm.length, sections, userCode, runtimeCode, data, functions: names.length === bodies.length ? functions : [] };
}

/** Plain-text summary for the AI and the log. */
export function formatSizeReport(r: WasmSizeReport): string {
  const rest = r.total - r.userCode - r.runtimeCode - r.data;
  const code = r.functions.length
    ? `your code ${r.userCode} B, runtime and libraries ${r.runtimeCode} B`
    : `code ${r.userCode + r.runtimeCode} B (your code vs runtime: compile with the text format, wat)`;
  const lines = [
    `${r.total} bytes: ${code}, static data ${r.data} B, rest (types, imports, exports, tables) ${rest} B`,
    `sections: ${r.sections.map((s) => `${s.name} ${s.bytes}`).join(', ')}`,
  ];
  if (r.functions.length) {
    lines.push('largest functions:');
    for (const f of r.functions.slice(0, 15)) lines.push(`  ${f.bytes.toString().padStart(6)} B  ${f.user ? 'yours  ' : 'runtime'}  ${f.name}`);
  }
  return lines.join('\n');
}

/**
 * The text format reordered for reading: the module header (types, imports, exports, memory,
 * data), then the user's functions, then the runtime's, cut at `max` characters with a note of
 * what was left out. Function bodies are kept whole.
 */
export function readableWat(wat: string, max = 15000): string {
  const lines = wat.split('\n');
  const header: string[] = [];
  const funcs: Array<{ name: string; text: string }> = [];
  let current: { name: string; lines: string[] } | null = null;
  for (const line of lines) {
    const start = /^ \(func \$(\S+)/.exec(line);
    if (start) {
      if (current) funcs.push({ name: current.name, text: current.lines.join('\n') });
      current = { name: start[1], lines: [line] };
    } else if (current && /^ \(/.test(line)) {
      funcs.push({ name: current.name, text: current.lines.join('\n') });
      current = null;
      header.push(line);
    } else if (current) {
      current.lines.push(line);
    } else {
      header.push(line);
    }
  }
  if (current) funcs.push({ name: current.name, text: current.lines.join('\n') });
  // Header: imports, exports, memory, start and the user's globals in full; the rest counted.
  const counts: Record<string, number> = {};
  const kept: string[] = [];
  for (const l of header) {
    const kind = /^ \((\w+)/.exec(l)?.[1];
    if (!kind) { if (l.startsWith('(module')) kept.push(l); continue; }
    const userGlobal = kind === 'global' && !/\$~lib\//.test(l);
    if (['import', 'export', 'memory', 'start'].includes(kind) || userGlobal) kept.push(l.length > 200 ? `${l.slice(0, 200)} …` : l);
    else counts[kind] = (counts[kind] ?? 0) + 1;
  }
  const summary = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
  const head = `${kept.join('\n')}${summary ? `\n ;; not shown: ${summary} (types, runtime globals, string and table data)` : ''}`;
  const ordered = [...funcs.filter((f) => isUser(f.name)), ...funcs.filter((f) => !isUser(f.name))];
  let out = `${head}\n ;; ---- functions: yours first, then the runtime and libraries ----\n`;
  const omitted: string[] = [];
  for (const f of ordered) {
    if (out.length + f.text.length > max && !isUser(f.name)) omitted.push(f.name);
    else out += `${f.text}\n`;
  }
  if (omitted.length) out += ` ;; ${omitted.length} more runtime functions not shown: ${omitted.slice(0, 40).join(', ')}${omitted.length > 40 ? ', …' : ''}\n`;
  return `${out})`;
}
