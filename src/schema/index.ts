// Browser-safe ASTRA schema loader. Persistent caches and filesystem reads are
// host concerns; this module only fetches and keeps an in-memory copy.

export type JsonSchema = Record<string, unknown>;

export interface SchemaLoadOptions {
  /** Version segment in the URL path. Defaults to "latest". */
  version?: string;
  /** Explicit fetchable URL override. Wins over `version`. */
  url?: string;
  /** Bypass the in-memory cache and fetch fresh. */
  force?: boolean;
}

const memoryCache = new Map<string, JsonSchema>();

export const ASTRA_SPEC_HOST = "https://astra-spec.org";

export function astraSchemaUrl(version = "latest"): string {
  return `${ASTRA_SPEC_HOST}/${version}/schema/astra.schema.json`;
}

export async function loadAstraSchema(
  options: SchemaLoadOptions = {},
): Promise<JsonSchema> {
  const url = options.url ?? astraSchemaUrl(options.version ?? "latest");
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
  const url = options.url ?? astraSchemaUrl(options.version ?? "latest");
  memoryCache.set(url, schema);
}

export function clearAstraSchemaCache(): void {
  memoryCache.clear();
}
