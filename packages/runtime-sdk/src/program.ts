/**
 * Program blobs and the live-reload protocol, matching firmware/esplab-runtime/main/main.c.
 */

/**
 * Where programs live in the flash image. The runtime uses the Tasmota-compatible layout: the
 * program store is the data partition at 0x3B0000 (Tasmota's spiffs/littlefs), and the firmware
 * finds it by type, so a device converted from Tasmota works the same way.
 */
export const PROGRAM_OFFSET = 0x3b0000;
export const PROGRAM_PARTITION_SIZE = 0x50000;
const HEADER_SIZE = 16;
/** One program slot (the store will hold two for OTA with rollback). Programs are a few KB. */
export const MAX_PROGRAM_BYTES = 0x20000 - HEADER_SIZE;

const PARTITION_TABLE = 0x8000;

/**
 * Finds the program store in a flash image's partition table: a data partition with subtype 0x40
 * (ESP Lab's own), else littlefs (0x82), else spiffs (0x81), as the firmware does.
 */
export function programPartition(image: Uint8Array): { offset: number; size: number } {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const found: Array<{ subtype: number; offset: number; size: number }> = [];
  for (let at = PARTITION_TABLE; at + 32 <= Math.min(image.length, PARTITION_TABLE + 0xc00); at += 32) {
    if (image[at] !== 0xaa || image[at + 1] !== 0x50) break;
    if (image[at + 2] === 1) found.push({ subtype: image[at + 3], offset: view.getUint32(at + 4, true), size: view.getUint32(at + 8, true) });
  }
  for (const subtype of [0x40, 0x82, 0x81]) {
    const part = found.find((p) => p.subtype === subtype);
    if (part) return { offset: part.offset, size: part.size };
  }
  return { offset: PROGRAM_OFFSET, size: PROGRAM_PARTITION_SIZE };
}

let table: Uint32Array | null = null;

/** CRC-32 (IEEE 802.3, the zlib one), as checked by the firmware. */
export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** "ELRT" header + wasm, as stored in the program partition. */
export function packProgram(wasm: Uint8Array): Uint8Array {
  if (wasm.length > MAX_PROGRAM_BYTES) {
    throw new Error(`Program is ${wasm.length} bytes; the limit is ${MAX_PROGRAM_BYTES}.`);
  }
  const blob = new Uint8Array(HEADER_SIZE + wasm.length);
  const view = new DataView(blob.buffer);
  blob.set([0x45, 0x4c, 0x52, 0x54], 0); // "ELRT"
  view.setUint16(4, 1, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, wasm.length, true);
  view.setUint32(12, crc32(wasm), true);
  blob.set(wasm, HEADER_SIZE);
  return blob;
}

/** Copies a runtime flash image and writes the program blob into its program store. */
export function flashWithProgram(runtimeImage: ArrayBuffer | Uint8Array, wasm: Uint8Array): Uint8Array {
  const source = runtimeImage instanceof Uint8Array ? runtimeImage : new Uint8Array(runtimeImage);
  const part = programPartition(source);
  if (source.length < part.offset + part.size) {
    throw new Error('The runtime image is smaller than its partition table expects.');
  }
  const flash = source.slice();
  flash.fill(0xff, part.offset, part.offset + part.size);
  flash.set(packProgram(wasm), part.offset);
  return flash;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Console lines that live-load a program into a running device: header, then base64 chunks. */
export function liveLoadLines(wasm: Uint8Array): string[] {
  if (wasm.length > MAX_PROGRAM_BYTES) {
    throw new Error(`Program is ${wasm.length} bytes; the limit is ${MAX_PROGRAM_BYTES}.`);
  }
  const encoded = base64(wasm);
  const lines = [`ESPLAB LOAD ${wasm.length} ${crc32(wasm).toString(16).padStart(8, '0')}`];
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
  return lines;
}

/** Firmware console markers that tools and the UI react to. */
export const RUNTIME_MARKERS = {
  ready: /^\[vm\] ready \((\d+) byte program/m,
  trap: /^\[vm\] (?:trap in (\w+)\(\): (.*)|abort: (.*))$/m,
  stopped: /^\[vm\] stopped\./m,
  loaded: /^ESPLAB OK (\d+)/m,
  loadError: /^ESPLAB ERR (.*)$/m,
  noProgram: /^\[vm\] no program stored/m,
} as const;

/**
 * The part of a flash image worth writing to a real board: everything up to the last non-erased
 * byte before `limit`, rounded up to a 4 KiB sector. The runtime image is 4 MB but only the part up
 * to the end of the app (bootloader, partition table, otadata, app0) holds data; erased flash
 * already reads 0xFF. Esptool compresses the empty factory slot, so it costs little time.
 */
export function trimFlashImage(image: Uint8Array, limit = programPartition(image).offset): Uint8Array {
  let end = Math.min(limit, image.length);
  while (end > 0 && image[end - 1] === 0xff) end--;
  const rounded = Math.min(Math.ceil(end / 4096) * 4096, image.length);
  return image.subarray(0, rounded);
}
