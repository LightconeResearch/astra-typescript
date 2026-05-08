// Structural (JSON Schema) validation. The schema itself is fetched on
// demand from astra-spec.org via `loadAstraSchema` and cached in memory
// + on disk; consumers can also pass a pre-loaded schema directly.

import Ajv2019 from "ajv/dist/2019.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  type JsonSchema,
  type SchemaLoadOptions,
  astraSchemaUrl,
  loadAstraSchema,
} from "../schema/index.js";
import {
  injectAnalysisIdsInPlace,
  injectUniverseIdsInPlace,
  loadYaml,
} from "../helpers.js";

export interface ValidateOptions extends SchemaLoadOptions {
  /** Pre-loaded schema. Wins over any loader options. */
  schema?: JsonSchema;
}

interface CompiledValidators {
  analysis: ValidateFunction;
  universe: ValidateFunction;
}

const _compiledCache = new WeakMap<JsonSchema, CompiledValidators>();

function compileFor(schema: JsonSchema): CompiledValidators {
  const cached = _compiledCache.get(schema);
  if (cached) return cached;

  // The published spec uses JSON Schema draft 2019-09.
  const ajv = new Ajv2019({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);

  const analysis = ajv.compile(schema);

  // Wrap to validate against `#/$defs/Universe`. Don't spread the root —
  // its top-level Analysis keywords would still apply alongside `$ref`.
  const universeWrapper: Record<string, unknown> = {
    $schema: schema.$schema,
    $defs: schema.$defs,
    $ref: "#/$defs/Universe",
  };
  const universe = ajv.compile(universeWrapper);

  const compiled = { analysis, universe };
  _compiledCache.set(schema, compiled);
  return compiled;
}

async function resolveSchema(opts: ValidateOptions): Promise<JsonSchema> {
  if (opts.schema) return opts.schema;
  return loadAstraSchema(opts);
}

function formatAjvError(err: ErrorObject): string {
  const path = err.instancePath
    ? err.instancePath.replace(/^\//, "").split("/").join(".")
    : "(root)";
  let msg = err.message ?? "validation error";
  if (err.keyword === "required" && (err.params as { missingProperty?: string }).missingProperty) {
    const missing = (err.params as { missingProperty: string }).missingProperty;
    msg = `missing required property '${missing}'`;
  }
  return path === "(root)" ? `(root): ${msg}` : `${path}: ${msg}`;
}

/** Validate an Analysis dict against the JSON Schema. Returns error
 *  strings (empty when valid). The schema is fetched from astra-spec.org
 *  on first use unless `opts.schema` is provided. */
export async function validateAnalysisData(
  data: Record<string, unknown>,
  opts: ValidateOptions = {},
): Promise<string[]> {
  const schema = await resolveSchema(opts);
  const { analysis } = compileFor(schema);
  const prepared = structuredClone(data);
  if (prepared.id === undefined) prepared.id = "root";
  injectAnalysisIdsInPlace(prepared);
  if (analysis(prepared)) return [];
  return (analysis.errors ?? []).map(formatAjvError);
}

export async function validateUniverseData(
  data: Record<string, unknown>,
  opts: ValidateOptions = {},
): Promise<string[]> {
  const schema = await resolveSchema(opts);
  const { universe } = compileFor(schema);
  const prepared = structuredClone(data);
  injectUniverseIdsInPlace(prepared);
  if (universe(prepared)) return [];
  return (universe.errors ?? []).map(formatAjvError);
}

export async function validateAnalysisFile(
  filePath: string,
  opts: ValidateOptions = {},
): Promise<string[]> {
  return validateAnalysisData(loadYaml(filePath), opts);
}

export async function validateUniverseFile(
  filePath: string,
  opts: ValidateOptions = {},
): Promise<string[]> {
  return validateUniverseData(loadYaml(filePath), opts);
}

export async function isValidAnalysis(
  filePath: string,
  opts: ValidateOptions = {},
): Promise<boolean> {
  return (await validateAnalysisFile(filePath, opts)).length === 0;
}

export async function isValidUniverse(
  filePath: string,
  opts: ValidateOptions = {},
): Promise<boolean> {
  return (await validateUniverseFile(filePath, opts)).length === 0;
}

// Re-export for convenience so callers don't need to import from two paths.
export { astraSchemaUrl, loadAstraSchema } from "../schema/index.js";
