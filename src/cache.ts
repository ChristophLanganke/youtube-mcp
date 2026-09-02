/**
 * TTL cache backed by a JSON file.
 *
 * Claude Desktop starts a fresh server process per session, so an in-process
 * dict would almost never hit. Persisting to disk is what makes a repeated
 * subscription feed cost close to nothing.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CACHE_DIR = path.join(os.homedir(), '.youtube-mcp');
const CACHE_PATH = path.join(CACHE_DIR, 'cache.json');
const FLUSH_DELAY_MS = 500;

export const TTL = {
  /** Subscriptions change rarely. */
  subscriptions: 24 * 60 * 60 * 1000,
  /** Uploads per channel — short enough to still feel live. */
  uploads: 12 * 60 * 1000,
  /** Handle -> channel ID mappings are effectively permanent. */
  handle: 30 * 24 * 60 * 60 * 1000,
};

interface Entry {
  value: unknown;
  expiresAt: number;
  etag?: string;
}

let store: Record<string, Entry> | null = null;
let flushTimer: NodeJS.Timeout | null = null;

function load(): Record<string, Entry> {
  if (store) return store;

  try {
    store = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  } catch {
    store = {};
  }

  return store!;
}

function flush(): void {
  if (!store) return;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(store), { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // A broken cache must never break a request.
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_DELAY_MS);
  // Do not hold the process open just to write the cache.
  flushTimer.unref?.();
}

/** Returns the value only while it is still fresh. */
export function cacheGet<T>(key: string): T | undefined {
  const entry = load()[key];
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) return undefined;
  return entry.value as T;
}

/** Returns an expired value plus its ETag, for revalidation via If-None-Match. */
export function cacheGetStale<T>(key: string): { value: T; etag?: string } | undefined {
  const entry = load()[key];
  if (!entry) return undefined;
  return { value: entry.value as T, etag: entry.etag };
}

export function cacheSet(key: string, value: unknown, ttlMs: number, etag?: string): void {
  const s = load();
  s[key] = { value, expiresAt: Date.now() + ttlMs, etag };
  scheduleFlush();
}

/** Re-stamps an entry's TTL after a 304, without rewriting the payload. */
export function cacheTouch(key: string, ttlMs: number): void {
  const s = load();
  const entry = s[key];
  if (!entry) return;
  entry.expiresAt = Date.now() + ttlMs;
  scheduleFlush();
}

export function cacheClear(): number {
  const count = Object.keys(load()).length;
  store = {};
  flush();
  return count;
}

/** Drops expired entries so the file cannot grow without bound. */
export function cachePrune(): number {
  const s = load();
  const now = Date.now();
  let removed = 0;

  for (const [key, entry] of Object.entries(s)) {
    // Keep entries that still carry an ETag: revalidating them is free.
    if (now >= entry.expiresAt && !entry.etag) {
      delete s[key];
      removed++;
    }
  }

  if (removed) scheduleFlush();
  return removed;
}
