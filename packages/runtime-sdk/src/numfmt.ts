/**
 * Number formatting and parsing that the firmware does for programs (runtime 0.13+: esp.printNum,
 * esp.fmtNum, esp.parseNum). The test hosts use these; firmware/esplab-runtime/main/numfmt.c
 * follows the same rules:
 *
 * - decimals >= 0 (at most 9): fixed decimals, as toFixed();
 * - decimals < 0: whole numbers (below 1e15) without decimals, others as JavaScript prints them
 *   (shortest digits that read back exactly);
 * - NaN, Infinity, -Infinity as words; -0 prints as 0.
 *
 * Parsing reads the number at the start of the text, as parseFloat() does: NaN if there is none.
 */
export function formatNumber(v: number, decimals: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
  if (v === 0) v = 0;
  if (decimals >= 0) return v.toFixed(Math.min(decimals, 9));
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return v.toFixed(0);
  return String(v);
}

export function parseNumber(text: string): number {
  return parseFloat(text);
}

/** The esp imports for numbers, for a JS host with access to the program's memory. */
export function numberImports(host: { mem: () => Uint8Array; str16: (ptr: number, bytes: number) => string; print: (text: string) => void }) {
  return {
    printNum(v: number, decimals: number) { host.print(formatNumber(v, decimals)); },
    fmtNum(v: number, decimals: number, out: number, capBytes: number) {
      const text = formatNumber(v, decimals);
      const n = Math.min(text.length, capBytes >> 1);
      const view = new DataView(host.mem().buffer);
      for (let i = 0; i < n; i++) view.setUint16(out + i * 2, text.charCodeAt(i), true);
      return n * 2;
    },
    parseNum(ptr: number, bytes: number) { return parseNumber(host.str16(ptr, bytes)); },
  };
}
