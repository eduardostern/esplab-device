/**
 * Compiles an ESP Lab Runtime program (AssemblyScript) to wasm, entirely in memory.
 *
 * The AssemblyScript compiler is passed in, so the same code runs in the browser's compiler
 * worker (with the bundled compiler) and in Node (with the `assemblyscript` package).
 */
import { ESP_LIB_SOURCE } from './esp-lib';
import { IO_LIB_SOURCE } from './io-lib';
import { LAB_LIB_SOURCE } from './lab-lib';
import { MAX_PROGRAM_BYTES } from './program';
import { wasmSizeReport, type WasmSizeReport } from './wasm-size';

export interface CompileDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: number;
  message: string;
  file: string | null;
  /** 1-based line and column, when the compiler gave a location. */
  line: number | null;
  column: number | null;
  endLine: number | null;
  endColumn: number | null;
}

export interface CompileResult {
  ok: boolean;
  wasm: Uint8Array | null;
  diagnostics: CompileDiagnostic[];
  /** Plain-text log in the compiler's own format, for the AI and the log panel. */
  log: string;
  durationMs: number;
  /** What the module is made of (section and function sizes); function names need `wat`. */
  size?: WasmSizeReport;
  /** The WebAssembly text format of the same module, when asked for (options.wat). */
  wat?: string;
}

/** Subset of the `assemblyscript/asc` module this needs. */
export interface AscModule {
  main(
    argv: string[],
    options: {
      readFile: (name: string, baseDir: string) => string | null;
      writeFile: (name: string, contents: Uint8Array | string, baseDir: string) => void;
      listFiles: (dirname: string, baseDir: string) => string[] | null;
      reportDiagnostic?: (diagnostic: AscDiagnostic) => void;
      stdout?: { write: (text: string) => void };
      stderr?: { write: (text: string) => void };
    },
  ): Promise<{ error: Error | null }>;
}

interface AscDiagnostic {
  code: number;
  category: number;
  message: string;
  range: { start: number; end: number; source: { normalizedPath: string; text?: string } } | null;
}

/**
 * Compiler flags shared by every build. Programs start with one 64 KiB page and may grow to two:
 * the firmware reserves a 128 KiB block at boot, before Wi-Fi fragments the heap.
 */
export const COMPILER_FLAGS = [
  '--runtime',
  'incremental',
  '-Oz',
  '--initialMemory',
  '1',
  '--maximumMemory',
  '2',
  // The incremental GC's shadow stack (references held by active frames) takes 32 KiB of the
  // first page by default; 12 KiB is plenty for device programs and frees 20 KiB of heap.
  '--stackSize',
  '12288',
  '--lib',
  'lib',
] as const;

const LIB_DIR = 'lib';

/** Joins the compiler's (baseDir, name) pair into a key of the in-memory file map. */
function join(baseDir: string, name: string): string {
  const parts = `${baseDir && baseDir !== '.' ? `${baseDir}/` : ''}${name}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function position(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function severityOf(category: number): CompileDiagnostic['severity'] {
  // AssemblyScript DiagnosticCategory: 0 pedantic, 1 info, 2 warning, 3 error
  return category === 3 ? 'error' : category === 2 ? 'warning' : 'info';
}

/** Strips "./" and the compiler's internal prefixes so diagnostics name the user's files. */
function displayPath(normalizedPath: string): string {
  return normalizedPath.replace(/^\.\//, '').replace(/^~lib\/(esp|lab|io)(\.ts)?$/, '$1 (library)');
}

/**
 * @param files project files by path; `entry` must be one of them (default "main.ts").
 */
export async function compileProgram(
  asc: AscModule,
  files: Record<string, string>,
  entry = 'main.ts',
  /** Extra compiler flags (tests: e.g. --exportStart to run top-level code after instantiation). */
  extraFlags: string[] = [],
  /** wat: also produce the text format (to view the compiled program, and to name functions in the size report). */
  options: { wat?: boolean } = {},
): Promise<CompileResult> {
  const started = Date.now();
  const sources: Record<string, string> = { [`${LIB_DIR}/esp.ts`]: ESP_LIB_SOURCE, [`${LIB_DIR}/lab.ts`]: LAB_LIB_SOURCE, [`${LIB_DIR}/io.ts`]: IO_LIB_SOURCE };
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith('.ts')) sources[path.replace(/^\.?\//, '')] = content;
  }
  if (!(entry in sources)) {
    const message = `No ${entry} in the project. Programs start in ${entry} and export setup() and/or loop().`;
    return {
      ok: false,
      wasm: null,
      diagnostics: [{ severity: 'error', code: 0, message, file: entry, line: null, column: null, endLine: null, endColumn: null }],
      log: message,
      durationMs: Date.now() - started,
    };
  }

  // "lab" programs declare an App and export nothing: a generated entry runs main.ts and exports
  // the framework's event loop. Classic programs (export setup/loop) are compiled as they are.
  let root = entry;
  const main = sources[entry];
  if (/from\s+["']lab["']/.test(main) && !/export\s+function\s+(setup|loop)\b/.test(main)) {
    root = '__entry.ts';
    sources[root] = `import "./${entry.replace(/\.ts$/, '')}";\nexport { __lab_run } from "lab";\n`;
  }

  const outputs: Record<string, Uint8Array | string> = {};
  const diagnostics: CompileDiagnostic[] = [];
  let log = '';

  const textFlags = options.wat ? ['--textFile', 'program.wat'] : [];
  const { error } = await asc.main([root, '--outFile', 'program.wasm', ...textFlags, ...COMPILER_FLAGS, ...extraFlags], {
    readFile: (name, baseDir) => sources[join(baseDir, name)] ?? null,
    writeFile: (name, contents) => {
      outputs[name] = contents;
    },
    listFiles: (dirname, baseDir) => {
      const dir = join(baseDir, dirname);
      return Object.keys(sources)
        .filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'))
        .map((path) => path.slice(dir.length + 1));
    },
    reportDiagnostic: (d) => {
      const range = d.range;
      // The reporter only guarantees the path; the text comes from our own file map.
      const path = range?.source.normalizedPath ?? '';
      const text = range?.source.text ?? sources[path] ?? sources[path.replace(/^~lib\//, `${LIB_DIR}/`)] ?? null;
      const start = range && text !== null ? position(text, range.start) : null;
      const end = range && text !== null ? position(text, range.end) : null;
      diagnostics.push({
        severity: severityOf(d.category),
        code: d.code,
        message: d.message,
        file: range ? displayPath(range.source.normalizedPath) : null,
        line: start?.line ?? null,
        column: start?.column ?? null,
        endLine: end?.line ?? null,
        endColumn: end?.column ?? null,
      });
    },
    stdout: { write: (text) => void (log += text) },
    stderr: { write: (text) => void (log += text) },
  });

  const wasm = outputs['program.wasm'];
  const bytes = wasm instanceof Uint8Array ? wasm : null;
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (bytes && bytes.length > MAX_PROGRAM_BYTES) {
    errors.push({
      severity: 'error',
      code: 0,
      message: `The program is ${bytes.length} bytes; the device holds at most ${MAX_PROGRAM_BYTES}.`,
      file: null,
      line: null,
      column: null,
      endLine: null,
      endColumn: null,
    });
    diagnostics.push(errors[errors.length - 1]);
  }
  const ok = !error && errors.length === 0 && bytes !== null && bytes.length <= MAX_PROGRAM_BYTES;
  const summary = diagnostics
    .map((d) => `${d.severity.toUpperCase()} ${d.file ?? ''}${d.line ? `:${d.line}:${d.column}` : ''} ${d.message}`.trim())
    .join('\n');

  const wat = typeof outputs['program.wat'] === 'string' ? (outputs['program.wat'] as string) : undefined;
  return {
    ok,
    wasm: ok ? bytes : null,
    ...(ok && bytes ? { size: wasmSizeReport(bytes, wat) } : {}),
    ...(ok && wat ? { wat } : {}),
    diagnostics,
    log: ok
      ? `compiled ${entry} -> ${bytes!.length} bytes${summary ? `\n${summary}` : ''}`
      : summary || error?.message || 'Compilation failed.',
    durationMs: Date.now() - started,
  };
}
