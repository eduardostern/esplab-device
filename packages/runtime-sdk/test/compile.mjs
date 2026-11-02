// Compiles test programs with the SDK (TypeScript source, run through tsx) and AssemblyScript.
import { createRequire } from 'node:module';
import path from 'node:path';

import { compileProgram } from '../src/index.ts';

const require = createRequire(import.meta.url);
const ascPath = path.join(path.dirname(require.resolve('assemblyscript/package.json')), 'dist/asc.js');

export async function build(files, extra = []) {
  const asc = await import(ascPath);
  return compileProgram(asc, files, 'main.ts', extra);
}
