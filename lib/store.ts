/**
 * lib/store.ts — tiny key/value abstraction.
 *
 * Production: Upstash Redis over REST (free tier, works from any serverless
 * function; no connection pooling to worry about).
 * Local dev without credentials: an in-memory Map so `npm run dev` just works.
 *
 * WHY NOT THE FILESYSTEM? Vercel functions have a read-only, per-instance
 * filesystem. Anything written there disappears. Knowledge must live in an
 * external store.
 *
 * PRIVACY RULE: nothing in this app ever writes chat or complaint text here.
 * The store only holds admin-uploaded documents, settings, a small audit log
 * of admin actions, and hashed rate-limit counters.
 */
import { Redis } from "@upstash/redis";

export interface Store {
  readonly kind: "upstash" | "memory";
  getJSON<T>(key: string): Promise<T | null>;
  setJSON(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  hsetJSON(key: string, field: string, value: unknown): Promise<void>;
  hgetallJSON<T>(key: string): Promise<Record<string, T>>;
  hdel(key: string, field: string): Promise<void>;
  /** Push to the head of a list and cap its length. */
  lpushCapped(key: string, value: unknown, cap: number): Promise<void>;
  lrangeJSON<T>(key: string, count: number): Promise<T[]>;
  /** Fixed-window counter: increments and returns the new value. */
  incrWindow(key: string, windowSeconds: number): Promise<number>;
}

const parse = <T>(raw: unknown): T | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

class UpstashStore implements Store {
  readonly kind = "upstash" as const;
  constructor(private r: Redis) {}

  async getJSON<T>(key: string) {
    return parse<T>(await this.r.get<string>(key));
  }
  async setJSON(key: string, value: unknown) {
    await this.r.set(key, JSON.stringify(value));
  }
  async del(key: string) {
    await this.r.del(key);
  }
  async hsetJSON(key: string, field: string, value: unknown) {
    await this.r.hset(key, { [field]: JSON.stringify(value) });
  }
  async hgetallJSON<T>(key: string) {
    const raw = (await this.r.hgetall<Record<string, string>>(key)) ?? {};
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(raw)) {
      const p = parse<T>(v);
      if (p !== null) out[k] = p;
    }
    return out;
  }
  async hdel(key: string, field: string) {
    await this.r.hdel(key, field);
  }
  async lpushCapped(key: string, value: unknown, cap: number) {
    const p = this.r.pipeline();
    p.lpush(key, JSON.stringify(value));
    p.ltrim(key, 0, cap - 1);
    await p.exec();
  }
  async lrangeJSON<T>(key: string, count: number) {
    const raw = await this.r.lrange<string>(key, 0, count - 1);
    return raw.map((v) => parse<T>(v)).filter((v): v is T => v !== null);
  }
  async incrWindow(key: string, windowSeconds: number) {
    const n = await this.r.incr(key);
    if (n === 1) await this.r.expire(key, windowSeconds);
    return n;
  }
}

class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private kv = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private lists = new Map<string, string[]>();
  private counters = new Map<string, { n: number; exp: number }>();

  async getJSON<T>(key: string) {
    return parse<T>(this.kv.get(key) ?? null);
  }
  async setJSON(key: string, value: unknown) {
    this.kv.set(key, JSON.stringify(value));
  }
  async del(key: string) {
    this.kv.delete(key);
    this.hashes.delete(key);
    this.lists.delete(key);
  }
  async hsetJSON(key: string, field: string, value: unknown) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    this.hashes.get(key)!.set(field, JSON.stringify(value));
  }
  async hgetallJSON<T>(key: string) {
    const out: Record<string, T> = {};
    for (const [k, v] of this.hashes.get(key) ?? []) {
      const p = parse<T>(v);
      if (p !== null) out[k] = p;
    }
    return out;
  }
  async hdel(key: string, field: string) {
    this.hashes.get(key)?.delete(field);
  }
  async lpushCapped(key: string, value: unknown, cap: number) {
    const list = this.lists.get(key) ?? [];
    list.unshift(JSON.stringify(value));
    this.lists.set(key, list.slice(0, cap));
  }
  async lrangeJSON<T>(key: string, count: number) {
    return (this.lists.get(key) ?? [])
      .slice(0, count)
      .map((v) => parse<T>(v))
      .filter((v): v is T => v !== null);
  }
  async incrWindow(key: string, windowSeconds: number) {
    const now = Date.now();
    const c = this.counters.get(key);
    if (!c || c.exp < now) {
      this.counters.set(key, { n: 1, exp: now + windowSeconds * 1000 });
      return 1;
    }
    c.n += 1;
    return c.n;
  }
}

// Accept both the Vercel-Marketplace names and Upstash's own names.
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// Keep one instance per server process (also survives Next dev hot reloads).
const g = globalThis as unknown as { __aegisStore?: Store };

export const store: Store =
  g.__aegisStore ??
  (g.__aegisStore =
    url && token
      ? new UpstashStore(new Redis({ url, token, automaticDeserialization: false }))
      : new MemoryStore());

if (store.kind === "memory" && process.env.VERCEL) {
  console.warn(
    "[aegis] Upstash Redis is not configured — uploads will NOT persist across serverless instances. " +
      "Add Upstash for Redis from the Vercel Marketplace.",
  );
}
