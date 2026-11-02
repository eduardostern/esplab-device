/**
 * @esplab/client: connect a website, app or server to the devices of an ESP Lab project.
 *
 *   import { connect } from "https://esp-lab.stern.workers.dev/sdk/esplab.js";
 *
 *   const lab = connect({ token });                    // or { getToken: () => fetch("/my-token").then(r => r.text()) }
 *   const pool = lab.device("esp32-246f28001122");
 *   pool.on("state", (s) => render(s.waterTemp, s.mode));
 *   pool.on("evt:mode.transition", (e) => console.log(e.from, "->", e.to));
 *   await pool.command("boost");                       // resolves with the device's answer
 *   await pool.setConfig({ target: 30 });
 *   const { series } = await pool.series(["waterTemp"], { from: Date.now() - 86400e3 });   // charts
 *   lab.on("alert", (a) => notify(a.n, a.state));     // alert rules set up in ESP Lab
 *
 * Browsers use short-lived tokens (minted by your server with a project secret key via
 * POST /v1/tokens); servers may connect with the secret key itself. Reconnects automatically.
 */
import type { AlertEntry, AppDown, DeviceSnapshot, Json, SeriesPoint } from '@esp/protocol';

export type { AlertEntry, AppDown, DeviceSnapshot, Json, SeriesPoint };

export interface SeriesResult {
  from: number;
  to: number;
  /** Bucket width in ms. */
  step: number;
  /** Per value: [bucket start ms, average, min, max]. */
  series: Record<string, SeriesPoint[]>;
}

export const DEFAULT_HUB = 'https://esp-lab-hub.stern.workers.dev';

export interface ConnectOptions {
  /** Hub base URL (https://…). Defaults to the public ESP Lab Hub. */
  url?: string;
  /** A token or secret key. */
  token?: string;
  /** Called for a fresh token on every (re)connect; use with short-lived tokens. */
  getToken?: () => Promise<string> | string;
  /** Topics to receive ("#" = everything): "<device>/state", "+/evt/alarm", "pool/#"… */
  topics?: string[];
  /** A WebSocket implementation (Node < 22). */
  WebSocket?: typeof WebSocket;
}

export interface CommandResult {
  ok: boolean;
  value: Json | null;
  error: string | null;
}

type Listener = (payload: any) => void;

class Emitter {
  private listeners = new Map<string, Set<Listener>>();
  on(event: string, fn: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }
  off(event: string, fn: Listener): void {
    this.listeners.get(event)?.delete(fn);
  }
  protected fire(event: string, payload: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        fn(payload);
      } catch (error) {
        console.error('[esplab] listener failed', error);
      }
    }
  }
}

/** One device of the project: its live state and the ways to talk to it. */
export class Device extends Emitter {
  state: Record<string, Json> = {};
  manifest: Json | null = null;
  online = false;
  lastSeen: number | null = null;
  name: string;
  /** device: on Wi-Fi; sub: a LoRa node reached through the gateway "via"; sim: ESP Lab's emulator. */
  kind: 'sim' | 'device' | 'sub' = 'device';
  via: string | null = null;
  /** LoRa nodes: signal of the last packet (dBm). */
  rssi: number | null = null;

  constructor(
    private hub: Hub,
    public readonly id: string,
  ) {
    super();
    this.name = id;
  }

  /** @internal */
  apply(frame: AppDown | { t: 'snapshot-one'; s: DeviceSnapshot }): void {
    switch (frame.t) {
      case 'snapshot-one':
        this.state = { ...frame.s.state };
        this.manifest = frame.s.manifest;
        this.online = frame.s.online;
        this.lastSeen = frame.s.lastSeen;
        this.name = frame.s.name;
        this.kind = frame.s.kind;
        this.via = frame.s.via ?? null;
        this.rssi = frame.s.rssi ?? null;
        this.fire('state', this.state);
        this.fire('presence', this.online);
        break;
      case 'state':
        Object.assign(this.state, frame.v);
        this.lastSeen = frame.at;
        this.fire('state', this.state);
        this.fire('change', frame.v);
        break;
      case 'evt':
        this.lastSeen = frame.at;
        this.fire(`evt:${frame.n}`, frame.v);
        this.fire('evt', { name: frame.n, value: frame.v, at: frame.at });
        break;
      case 'presence':
        this.online = frame.online;
        this.lastSeen = frame.at;
        this.fire('presence', frame.online);
        break;
      case 'hello':
        this.manifest = frame.m;
        this.fire('hello', frame.m);
        break;
      case 'alert':
        this.fire('alert', frame);
        break;
      default:
        break;
    }
  }

  /** Sends a command and resolves with the device's ack (rejects after timeoutMs or if offline). */
  command(name: string, value?: Json, options: { timeoutMs?: number; queueSeconds?: number } = {}): Promise<CommandResult> {
    return this.hub.command(this.id, name, value, options);
  }

  /** Changes settings (desired config); the device applies them now or when it reconnects. */
  setConfig(values: Record<string, Json>): void {
    this.hub.send({ t: 'cfg', d: this.id, v: values });
  }

  /** Recent events (newest last), from the hub's 7-day log. */
  history(limit = 50, since = 0): Promise<Array<{ seq: number; name: string; v: Json; at: number }>> {
    return this.hub.history(this.id, limit, since);
  }

  /** Values over time (numbers; booleans as 0/1), averaged per bucket. 30 days are kept. */
  series(keys: string[], options: { from?: number; to?: number; points?: number } = {}): Promise<SeriesResult> {
    return this.hub.series(this.id, keys, options);
  }

  /** Raises an event on the device: its state machines and app.on() hooks react. */
  emit(event: string): void {
    this.hub.send({ t: 'evt', d: this.id, n: event });
  }
}

export class Hub extends Emitter {
  readonly devices = new Map<string, Device>();
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private attempt = 0;
  private pending = new Map<string, { resolve: (r: CommandResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;
  private topics: string[];
  private outbox: string[] = [];
  connected = false;

  constructor(private options: ConnectOptions) {
    super();
    this.topics = options.topics ?? ['#'];
    void this.open();
  }

  device(id: string): Device {
    let device = this.devices.get(id);
    if (!device) this.devices.set(id, (device = new Device(this, id)));
    return device;
  }

  /** Changes the topics this connection receives. */
  subscribe(topics: string[]): void {
    this.topics = topics;
    this.send({ t: 'sub', topics });
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close(1000, 'closed');
  }

  /** @internal */
  send(frame: Record<string, unknown>): void {
    const text = JSON.stringify(frame);
    if (this.ws && this.connected) this.ws.send(text);
    else this.outbox.push(text);
  }

  private seriesWaiters = new Map<string, (result: SeriesResult) => void>();
  private alertWaiters: Array<(feed: { items: AlertEntry[]; firing: AlertEntry[] }) => void> = [];

  /** @internal */
  series(device: string, keys: string[], options: { from?: number; to?: number; points?: number }): Promise<SeriesResult> {
    const id = `s${(++this.seq).toString(36)}`;
    return new Promise((resolve) => {
      this.seriesWaiters.set(id, resolve);
      this.send({ t: 'series', id, d: device, keys, ...options });
    });
  }

  /** Recent alerts of the project and the ones firing now. */
  alerts(limit = 50): Promise<{ items: AlertEntry[]; firing: AlertEntry[] }> {
    return new Promise((resolve) => {
      this.alertWaiters.push(resolve);
      this.send({ t: 'alerts', limit });
    });
  }

  private historyWaiters = new Map<string, Array<(events: Array<{ seq: number; name: string; v: Json; at: number }>) => void>>();

  /** @internal */
  history(device: string, limit: number, since: number): Promise<Array<{ seq: number; name: string; v: Json; at: number }>> {
    return new Promise((resolve) => {
      const list = this.historyWaiters.get(device) ?? [];
      list.push(resolve);
      this.historyWaiters.set(device, list);
      this.send({ t: 'history', d: device, limit, since });
    });
  }

  /** @internal */
  command(device: string, name: string, value: Json | undefined, options: { timeoutMs?: number; queueSeconds?: number }): Promise<CommandResult> {
    const id = `c${Date.now().toString(36)}${(++this.seq).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`No answer from ${device} to "${name}"`));
      }, options.timeoutMs ?? 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ t: 'cmd', id, d: device, n: name, ...(value !== undefined ? { v: value } : {}), ...(options.queueSeconds ? { ttl: options.queueSeconds } : {}) });
    });
  }

  private async open(): Promise<void> {
    const base = (this.options.url ?? DEFAULT_HUB).replace(/\/$/, '').replace(/^http/, 'ws');
    let token = this.options.token;
    if (this.options.getToken) {
      try {
        token = await this.options.getToken();
      } catch (error) {
        this.fire('error', { code: 'token', message: String(error) });
        return this.retry();
      }
    }
    if (!token) throw new Error('connect() needs a token or getToken.');
    const Impl = this.options.WebSocket ?? globalThis.WebSocket;
    const ws = new Impl(`${base}/v1/connect?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.attempt = 0;
      if (this.topics.length !== 1 || this.topics[0] !== '#') ws.send(JSON.stringify({ t: 'sub', topics: this.topics }));
      for (const text of this.outbox.splice(0)) ws.send(text);
      this.fire('open', null);
    };
    ws.onmessage = (event) => this.onFrame(JSON.parse(String(event.data)) as AppDown);
    ws.onclose = (event) => {
      this.connected = false;
      this.fire('close', { code: event.code, reason: event.reason });
      if (!this.closedByUser) this.retry();
    };
    ws.onerror = () => this.fire('error', { code: 'socket', message: 'connection error' });
  }

  private retry(): void {
    if (this.closedByUser) return;
    const delay = Math.min(30_000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() / 2);
    setTimeout(() => void this.open(), delay);
  }

  private onFrame(frame: AppDown): void {
    switch (frame.t) {
      case 'welcome':
      case 'snapshot':
        for (const s of frame.devices) this.device(s.id).apply({ t: 'snapshot-one', s });
        this.fire(frame.t, frame.devices);
        break;
      case 'ack': {
        const waiter = this.pending.get(frame.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pending.delete(frame.id);
          waiter.resolve({ ok: frame.ok, value: frame.v ?? null, error: frame.err ?? null });
        }
        this.fire('ack', frame);
        break;
      }
      case 'error': {
        const waiter = frame.id ? this.pending.get(frame.id) : undefined;
        if (waiter && frame.id) {
          clearTimeout(waiter.timer);
          this.pending.delete(frame.id);
          waiter.reject(new Error(frame.message));
        }
        this.fire('error', frame);
        break;
      }
      case 'history': {
        const waiters = this.historyWaiters.get(frame.d) ?? [];
        this.historyWaiters.delete(frame.d);
        for (const resolve of waiters) resolve(frame.events);
        this.fire('history', frame);
        break;
      }
      case 'series': {
        const waiter = frame.id ? this.seriesWaiters.get(frame.id) : undefined;
        if (waiter && frame.id) {
          this.seriesWaiters.delete(frame.id);
          waiter({ from: frame.from, to: frame.to, step: frame.step, series: frame.series });
        }
        break;
      }
      case 'alerts': {
        for (const resolve of this.alertWaiters.splice(0)) resolve({ items: frame.items, firing: frame.firing });
        this.fire('alerts', frame);
        break;
      }
      case 'alert':
      case 'state':
      case 'evt':
      case 'presence':
      case 'hello': {
        this.device(frame.d).apply(frame);
        this.fire(frame.t, frame);
        break;
      }
      default:
        this.fire(frame.t, frame);
    }
  }
}

export function connect(options: ConnectOptions): Hub {
  return new Hub(options);
}

/** Server-side helper: exchanges a project secret key for a browser token. */
export async function createToken(
  secretKey: string,
  options: { url?: string; scopes?: Array<'read' | 'command' | 'config'>; devices?: string[]; ttlSeconds?: number } = {},
): Promise<{ token: string; expiresAt: number }> {
  const base = (options.url ?? DEFAULT_HUB).replace(/\/$/, '');
  const response = await fetch(`${base}/v1/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ scopes: options.scopes, devices: options.devices, ttl: options.ttlSeconds }),
  });
  if (!response.ok) throw new Error(`ESP Lab Hub refused the key (${response.status})`);
  return (await response.json()) as { token: string; expiresAt: number };
}
