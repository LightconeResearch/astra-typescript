// Structural (JSON Schema) validation. The schema itself is fetched on
// demand from astra-spec.org via `loadAstraSchema` and cached in memory;
// consumers can also pass a pre-loaded schema directly.

import Ajv2019 from "ajv/dist/2019.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  type JsonSchema,
  type SchemaLoadOptions,
  loadAstraSchema,
} from "../schema/index.js";
import {
  injectAnalysisIdsInPlace,
  injectUniverseIdsInPlace,
} from "../helpers.js";

export interface ValidateOptions extends SchemaLoadOptions {
  /** Pre-loaded schema. Wins over any loader options. */
  schema?: JsonSchema;
}

export interface SchemaValidationIssue {
  code: string;
  message: string;
  path?: string;
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

function ajvErrorPath(error: ErrorObject): string | undefined {
  const segments = error.instancePath
    ? error.instancePath.replace(/^\//, "").split("/")
    : [];
  if (error.keyword === "required") {
    const missing = (error.params as { missingProperty?: string }).missingProperty;
    if (missing) segments.push(missing);
  } else if (error.keyword === "additionalProperties") {
    const extra = (error.params as { additionalProperty?: string }).additionalProperty;
    if (extra) segments.push(extra);
  }
  return segments.length ? segments.join(".") : undefined;
}

function structuredErrors(
  validator: ValidateFunction,
): SchemaValidationIssue[] {
  return (validator.errors ?? []).map((error) => {
    const path = ajvErrorPath(error);
    return {
      code: `SCHEMA_${error.keyword.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}`,
      message: error.message ?? "Schema validation failed",
      ...(path ? { path } : {}),
    };
  });
}

export async function validateAnalysisStructure(
  data: Record<string, unknown>,
  opts: ValidateOptions = {},
): Promise<SchemaValidationIssue[]> {
  const schema = await resolveSchema(opts);
  const { analysis } = compileFor(schema);
  const prepared = structuredClone(data);
  if (prepared.id == null) prepared.id = "root";
  injectAnalysisIdsInPlace(prepared);
  return analysis(prepared) ? [] : structuredErrors(analysis);
}

export async function validateUniverseStructure(
  data: Record<string, unknown>,
  opts: ValidateOptions = {},
): Promise<SchemaValidationIssue[]> {
  const schema = await resolveSchema(opts);
  const { universe } = compileFor(schema);
  const prepared = structuredClone(data);
  injectUniverseIdsInPlace(prepared);
  return universe(prepared) ? [] : structuredErrors(universe);
}

/** Validate an Analysis dict against the JSON Schema. Returns error
 *  strings (empty when valid). The schema is fetched from astra-spec.org
 *  on first use unless `opts.schema` is provided. */
export async function validateAnalysisData(
  data: Record<string, unknown>,
  opts: ValidateOptions = {},
): Promise<string[]> {
  const issues = await validateAnalysisStructure(data, opts);
  return issues.map((issue) =>
    issue.path ? `${issue.path}: ${issue.message}` : `(root): ${issue.message}`);
}

export async function validateUniverseData(
  data: Record<string, unknown>,
  opts: ValidateOptions = {},
): Promise<string[]> {
  const issues = await validateUniverseStructure(data, opts);
  return issues.map((issue) =>
    issue.path ? `${issue.path}: ${issue.message}` : `(root): ${issue.message}`);
}

// Re-export for convenience so callers don't need to import from two paths.
export { astraSchemaUrl, loadAstraSchema } from "../schema/index.js";
