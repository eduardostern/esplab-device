/**
 * elp/1: the ESP Lab protocol between devices, the hub and apps/websites, plus the hub's tokens.
 *
 * Devices speak the frames the lab framework writes (hello/state/evt/ack/cfgack up; cmd/cfg/
 * time/sync down). Apps connect to the hub and see every device of a project, addressed by
 * MQTT-style topics: "<device>/state", "<device>/evt/<name>", "<device>/presence",
 * "<device>/hello", "<device>/ack". Subscriptions use "+" (one level) and "#" (the rest).
 *
 * Runs in browsers, Node and Workers (WebCrypto only).
 */

// ---- frames ------------------------------------------------------------------------------

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Device -> hub. */
export type DeviceUp =
  | { t: 'hello'; proto: number; id: string; cfgVer: number; m: Json }
  | { t: 'state'; v: Record<string, Json> }
  | { t: 'evt'; n: string; v: Json; seq?: number }
  | { t: 'ack'; id: string | number | null; ok: boolean; v?: Json; err?: string }
  | { t: 'cfgack'; ver: number }
  /** A gateway forwarding a frame of one of its LoRa nodes ("bye": the node went silent). */
  | { t: 'sub'; id: string; rssi?: number; f: DeviceUp | { t: 'bye' } };

/** Hub -> device. */
export type DeviceDown =
  | { t: 'cmd'; id: string; n: string; v?: Json }
  | { t: 'cfg'; ver: number; v: Record<string, Json> }
  | { t: 'time'; ms: number }
  | { t: 'sync' }
  | { t: 'evt'; n: string }
  /** To a gateway: a frame for one of its LoRa nodes. */
  | { t: 'sub'; id: string; f: DeviceDown };

/** App -> hub. */
export type AppUp =
  | { t: 'sub'; topics: string[] }
  | { t: 'cmd'; id?: string; d: string; n: string; v?: Json }
  | { t: 'cfg'; d: string; v: Record<string, Json> }
  | { t: 'get'; d?: string }
  | { t: 'history'; d: string; limit?: number; since?: number }
  /** Value history for charts: averages (with min and max) per time bucket. */
  | { t: 'series'; id?: string; d: string; keys: string[]; from?: number; to?: number; points?: number }
  /** Recent alerts (firing, resolved and event alerts) of the project. */
  | { t: 'alerts'; limit?: number }
  | { t: 'ping' };

export interface DeviceSnapshot {
  id: string;
  name: string;
  /** sim: the IDE's emulator; device: on Wi-Fi; sub: a LoRa node reached through a gateway. */
  kind: 'sim' | 'device' | 'sub';
  online: boolean;
  lastSeen: number | null;
  manifest: Json | null;
  state: Record<string, Json>;
  cfgVer: number;
  desiredVer: number;
  /** Firmware version and whether ESP Lab Recovery is installed (real devices, once connected). */
  fw?: string | null;
  recovery?: boolean;
  /** The chip (esp32, esp32s3, esp32c3), as the firmware reports it. */
  target?: string;
  /** LoRa nodes: the gateway they are heard through, and the signal of their last packet (dBm). */
  via?: string | null;
  rssi?: number | null;
}

/** Hub -> app. */
export type AppDown =
  | { t: 'welcome'; project: string; devices: DeviceSnapshot[] }
  | { t: 'state'; d: string; v: Record<string, Json>; at: number }
  | { t: 'evt'; d: string; n: string; v: Json; at: number }
  | { t: 'presence'; d: string; online: boolean; at: number }
  | { t: 'hello'; d: string; m: Json; at: number }
  | { t: 'ack'; d: string; id: string; ok: boolean; v?: Json; err?: string }
  | { t: 'cfgack'; d: string; ver: number }
  | { t: 'snapshot'; devices: DeviceSnapshot[] }
  | { t: 'history'; d: string; events: Array<{ seq: number; name: string; v: Json; at: number }> }
  | { t: 'deploy'; d: string; id: string; state: DeployState; detail: string; at: number }
  | { t: 'series'; id?: string; d: string; from: number; to: number; step: number; series: Record<string, SeriesPoint[]> }
  | { t: 'alert'; d: string; rule: string; n: string; state: AlertState; v: Json; at: number }
  | { t: 'alerts'; items: AlertEntry[]; firing: AlertEntry[] }
  | { t: 'error'; code: string; message: string; id?: string }
  | { t: 'pong' };

/** One chart bucket: [bucket start ms, average, min, max]. */
export type SeriesPoint = [number, number, number, number];

/** firing: a condition started; resolved: it ended; event: a one-off (an event alert). */
export type AlertState = 'firing' | 'resolved' | 'event';

export interface AlertEntry {
  rule: string;
  n: string;
  d: string;
  state: AlertState;
  v: Json;
  at: number;
}

/**
 * An alert rule, evaluated by the hub (devices need nothing):
 * - above / below / equals: a value crosses a threshold (for forSec seconds);
 * - event: the device raises an event;
 * - offline: the device stays offline for forSec seconds.
 * Alerts reach apps (topic "<device>/alert"), webhooks subscribed to it and, with push,
 * the phones and browsers that turned on notifications in the dashboard.
 */
export interface AlertRule {
  id: string;
  name: string;
  /** A device id, or null for every device of the project. */
  device: string | null;
  kind: 'above' | 'below' | 'equals' | 'event' | 'offline';
  key?: string;
  value?: number | string | boolean;
  event?: string;
  forSec: number;
  push: boolean;
  enabled: boolean;
}

/** Over-the-air program deployment, as reported by the device. */
export type DeployState = 'pending' | 'sent' | 'downloading' | 'installed' | 'confirmed' | 'rolledback' | 'failed' | 'superseded';

/** CRC-32 (IEEE, zlib), as the firmware checks programs. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---- topics ------------------------------------------------------------------------------

/** The topic of a hub -> app frame, or null for frames that are not topic-routed. */
export function topicOf(frame: AppDown): string | null {
  switch (frame.t) {
    case 'state':
      return `${frame.d}/state`;
    case 'evt':
      return `${frame.d}/evt/${frame.n}`;
    case 'presence':
      return `${frame.d}/presence`;
    case 'hello':
      return `${frame.d}/hello`;
    case 'ack':
      return `${frame.d}/ack`;
    case 'cfgack':
      return `${frame.d}/cfgack`;
    case 'deploy':
      return `${frame.d}/deploy`;
    case 'alert':
      return `${frame.d}/alert`;
    default:
      return null;
  }
}

/** MQTT-style match: "+" is one level, "#" (last) is any number of levels. */
export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === '#') return true;
  const p = pattern.split('/');
  const t = topic.split('/');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return true;
    if (i >= t.length) return false;
    if (p[i] !== '+' && p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}

// ---- tokens ------------------------------------------------------------------------------

/**
 * Scoped, short-lived hub tokens, signed by ESP Lab (HMAC-SHA256 with HUB_SECRET):
 *   elp1.<base64url(json claims)>.<base64url(signature)>
 * - k "dev": a device (or the IDE's simulated device) of project pid, device id did.
 * - k "app": an app or website; sc = scopes ("read", "command", "config"); dv = allowed devices.
 * - k "admin": ESP Lab's own server calls (keys, usage).
 */
export interface TokenClaims {
  k: 'dev' | 'app' | 'admin';
  /** Project id. */
  pid: string;
  /** The project owner's user id (for metering). */
  uid: string;
  /** Device id (k = dev). */
  did?: string;
  /** Device kind (k = dev). */
  dk?: 'sim' | 'device';
  /** Scopes (k = app). */
  sc?: Array<'read' | 'command' | 'config'>;
  /** Allowed device ids (k = app); absent = all. */
  dv?: string[];
  /** The dashboard share this token was minted for (k = app); revoking the share cuts it off. */
  sh?: string;
  /** Expiry, seconds since 1970. */
  exp: number;
}

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signToken(claims: TokenClaims, secret: string): Promise<string> {
  const body = b64url(encoder.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`elp1.${body}`)));
  return `elp1.${body}.${b64url(sig)}`;
}

/** Returns the claims of a valid, unexpired token, else null. */
export async function verifyToken(token: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<TokenClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'elp1') return null;
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromB64url(parts[2]) as BufferSource,
      encoder.encode(`elp1.${parts[1]}`),
    );
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]))) as TokenClaims;
    if (typeof claims.exp !== 'number' || claims.exp < nowSeconds) return null;
    if (!claims.pid || !claims.uid || !['dev', 'app', 'admin'].includes(claims.k)) return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * Project secret keys, for users' servers: "esk_<project id without dashes>_<random>". The
 * project id inside routes the key to its hub; the hub stores only a SHA-256 of the key.
 */
export function projectIdFromSecretKey(key: string): string | null {
  const match = /^esk_([0-9a-f]{32})_[A-Za-z0-9]{24,}$/.exec(key);
  if (!match) return null;
  const h = match[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function newSecretKey(projectId: string): string {
  const random = new Uint8Array(24);
  crypto.getRandomValues(random);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let tail = '';
  for (const b of random) tail += alphabet[b % alphabet.length];
  return `esk_${projectId.replace(/-/g, '')}_${tail}`;
}

/**
 * Device keys, stored on a real device (NVS) and sent as "Authorization: Bearer <key>":
 * "edk_<project id without dashes>_<random>". The hub keeps only a SHA-256 and maps it to the
 * device id.
 */
export function projectIdFromDeviceKey(key: string): string | null {
  const match = /^edk_([0-9a-f]{32})_[A-Za-z0-9]{24,}$/.exec(key);
  if (!match) return null;
  const h = match[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function newDeviceKey(projectId: string): string {
  return newSecretKey(projectId).replace(/^esk_/, 'edk_');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Free hub traffic per account and month; beyond it, credits per block of messages. */
export const HUB_FREE_MESSAGES = 100_000;
export const HUB_MESSAGES_PER_CREDIT = 1_000;

/**
 * Devices in production: per account and month, the first HUB_FREE_DEVICES real devices (Wi-Fi or
 * LoRa) are free; each one more costs DEVICE_MONTH_CREDITS for the month it is connected. The
 * simulator and development are always free.
 */
export const HUB_FREE_DEVICES = 2;
export const DEVICE_MONTH_CREDITS = 1_000;

/**
 * Webhook signatures, like Stripe's: header "ESPLab-Signature: t=<unix seconds>,v1=<hex>"
 * where v1 = HMAC-SHA256(secret, "<t>.<raw body>"). Receivers should reject old timestamps.
 */
export async function webhookSignature(secret: string, body: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`${t}.${body}`)));
  return `t=${t},v1=${[...sig].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export async function verifyWebhookSignature(secret: string, body: string, header: string | null, toleranceSeconds = 300): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds || !parts.v1) return false;
  const expected = (await webhookSignature(secret, body, t)).split('v1=')[1];
  if (expected.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}
