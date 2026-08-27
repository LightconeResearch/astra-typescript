// Internal structural validation against the exact schema bundled with this SDK.

import Ajv2019 from "ajv/dist/2019.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  injectAnalysisTreeIds,
  injectUniverseTreeIds,
} from "../authored-ids.js";
import { bundledAstraSchema } from "../schema/bundled.js";

type Dict = Record<string, unknown>;

export interface SchemaValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

interface CompiledValidators {
  analysis: ValidateFunction;
  universe: ValidateFunction;
}

let compiledValidators: CompiledValidators | undefined;

function validators(): CompiledValidators {
  if (compiledValidators) return compiledValidators;

  const ajv = new Ajv2019({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  const analysis = ajv.compile(bundledAstraSchema);
  const universe = ajv.compile({
    $schema: bundledAstraSchema.$schema as string | undefined,
    $defs: bundledAstraSchema.$defs,
    $ref: "#/$defs/Universe",
  });
  compiledValidators = { analysis, universe };
  return compiledValidators;
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

function structuredErrors(validator: ValidateFunction): SchemaValidationIssue[] {
  return (validator.errors ?? []).map((error) => {
    const path = ajvErrorPath(error);
    return {
      code: `SCHEMA_${error.keyword.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}`,
      message: error.message ?? "Schema validation failed",
      ...(path ? { path } : {}),
    };
  });
}

export function validateAnalysisStructure(data: Dict): SchemaValidationIssue[] {
  const prepared = structuredClone(data);
  if (prepared.id == null) prepared.id = "root";
  injectAnalysisTreeIds(prepared);
  const { analysis } = validators();
  return analysis(prepared) ? [] : structuredErrors(analysis);
}

export function validateUniverseStructure(data: Dict): SchemaValidationIssue[] {
  const prepared = structuredClone(data);
  injectUniverseTreeIds(prepared);
  const { universe } = validators();
  return universe(prepared) ? [] : structuredErrors(universe);
}
