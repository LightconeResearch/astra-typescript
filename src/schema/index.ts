// Schema loader. The package no longer bundles the JSON Schema —
// instead we fetch the frozen, versioned artifact from astra-spec.org
// (cached in memory, with an optional on-disk cache for repeat runs).

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type JsonSchema = Record<string, unknown>;

export interface SchemaLoadOptions {
  /** Version segment in the URL path. Defaults to "latest". */
  version?: string;
  /** Explicit URL override. Wins over `version`. Supports `https://` and `file://`. */
  url?: string;
  /**
   * Directory used as the on-disk cache. Set to `null` (or `false`) to
   * disable disk caching entirely. Defaults to `<tmpdir>/astra-schema-cache`.
   */
  cacheDir?: string | null | false;
  /** Bypass both in-memory and on-disk caches and fetch fresh. */
  force?: boolean;
}

const _memoryCache = new Map<string, JsonSchema>();

export const ASTRA_SPEC_HOST = "https://astra-spec.org";

/** Build the canonical schema URL for a given version. */
export function astraSchemaUrl(version = "latest"): string {
  return `${ASTRA_SPEC_HOST}/${version}/schema/astra.schema.json`;
}

function defaultCacheDir(): string {
  return join(tmpdir(), "astra-schema-cache");
}

function cacheFileFor(url: string, dir: string): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  return join(dir, `${hash}.json`);
}

async function readUrl(url: string): Promise<JsonSchema> {
  if (url.startsWith("file://")) {
    const text = readFileSync(fileURLToPath(url), "utf8");
    return JSON.parse(text) as JsonSchema;
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ASTRA schema from ${url}: HTTP ${res.status}`);
  }
  return (await res.json()) as JsonSchema;
}

/**
 * Load the ASTRA JSON Schema. Default source is
 * `https://astra-spec.org/latest/schema/astra.schema.json`.
 *
 * Subsequent calls with the same URL hit an in-memory cache. With disk
 * caching enabled (the default), the schema is also persisted under
 * `<tmpdir>/astra-schema-cache` so future processes don't have to refetch.
 */
export async function loadAstraSchema(opts: SchemaLoadOptions = {}): Promise<JsonSchema> {
  const url = opts.url ?? astraSchemaUrl(opts.version ?? "latest");

  if (!opts.force) {
    const cached = _memoryCache.get(url);
    if (cached) return cached;
  }

  const useDisk = opts.cacheDir !== null && opts.cacheDir !== false;
  const cacheDir = typeof opts.cacheDir === "string" ? opts.cacheDir : defaultCacheDir();
  const cachePath = useDisk ? cacheFileFor(url, cacheDir) : null;

  if (cachePath && !opts.force) {
    try {
      const text = readFileSync(cachePath, "utf8");
      const schema = JSON.parse(text) as JsonSchema;
      _memoryCache.set(url, schema);
      return schema;
    } catch {
      // Fall through to network fetch.
    }
  }

  const schema = await readUrl(url);
  _memoryCache.set(url, schema);

  if (cachePath) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cachePath, JSON.stringify(schema));
    } catch {
      // Best-effort cache; ignore write failures.
    }
  }

  return schema;
}

/** Install a pre-loaded schema in the in-memory cache. Useful for tests
 *  and for environments where the consumer prefers to manage fetching. */
export function setAstraSchema(schema: JsonSchema, opts: { url?: string; version?: string } = {}): void {
  const url = opts.url ?? astraSchemaUrl(opts.version ?? "latest");
  _memoryCache.set(url, schema);
}

/** Drop all cached schemas from memory. */
export function clearAstraSchemaCache(): void {
  _memoryCache.clear();
}
