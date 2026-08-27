// Browser-safe ASTRA schema loader. The SDK's supported schema is bundled so
// ordinary parsing and resolution are deterministic and work offline. Explicit
// historical/latest URLs are fetched and cached in memory.

import {
  BUNDLED_ASTRA_SPEC_VERSION,
  bundledAstraSchema,
} from "./bundled.js";

export type JsonSchema = Record<string, unknown>;

export interface SchemaLoadOptions {
  /** Explicit remote version segment. Omit to use the bundled schema. */
  version?: string;
  /** Explicit fetchable URL override. Wins over `version`. */
  url?: string;
  /** Bypass the in-memory cache for an explicit remote source. */
  force?: boolean;
}

const memoryCache = new Map<string, JsonSchema>();
const BUNDLED_CACHE_KEY = `bundled:${BUNDLED_ASTRA_SPEC_VERSION}`;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const immutableBundledSchema = deepFreeze(bundledAstraSchema);

export const ASTRA_SPEC_HOST = "https://astra-spec.org";
/** The astra-spec release whose schema is bundled with this SDK. */
export const ASTRA_SPEC_VERSION = BUNDLED_ASTRA_SPEC_VERSION;

export function astraSchemaUrl(version: string = ASTRA_SPEC_VERSION): string {
  return `${ASTRA_SPEC_HOST}/${version}/schema/astra.schema.json`;
}

export async function loadAstraSchema(
  options: SchemaLoadOptions = {},
): Promise<JsonSchema> {
  if (options.url === undefined && options.version === undefined) {
    const installed = memoryCache.get(BUNDLED_CACHE_KEY);
    if (installed) return installed;
    memoryCache.set(BUNDLED_CACHE_KEY, immutableBundledSchema);
    return immutableBundledSchema;
  }

  const url = options.url ?? astraSchemaUrl(options.version);
  if (!options.force) {
    const cached = memoryCache.get(url);
    if (cached) return cached;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ASTRA schema from ${url}: HTTP ${response.status}`);
  }
  const schema = await response.json() as JsonSchema;
  memoryCache.set(url, schema);
  return schema;
}

export function setAstraSchema(
  schema: JsonSchema,
  options: { url?: string; version?: string } = {},
): void {
  const key = options.url
    ?? (options.version === undefined
      ? BUNDLED_CACHE_KEY
      : astraSchemaUrl(options.version));
  memoryCache.set(key, schema);
}

export function clearAstraSchemaCache(): void {
  memoryCache.clear();
}
