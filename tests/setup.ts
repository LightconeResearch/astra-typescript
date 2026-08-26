import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { JsonSchema } from "../src/schema/index.js";

// Use the generated schema from the canonical sibling checkout so tests are
// deterministic and exercise the same contract as astra-spec.

const FIXTURES_DIR = resolve(__dirname, "fixtures");
const SCHEMA_PATH = resolve(__dirname, "../../astra-spec/docs/schema/astra.schema.json");

export const FIXTURES = {
  validAnalysis: join(FIXTURES_DIR, "valid/Analysis-001.yaml"),
  validUniverse: join(FIXTURES_DIR, "valid/Universe-001.yaml"),
  invalidDir: join(FIXTURES_DIR, "invalid"),
  irisAnalysis: join(FIXTURES_DIR, "examples/iris/astra.yaml"),
  irisUniverseBaseline: join(FIXTURES_DIR, "examples/iris/universes/baseline.yaml"),
  irisPipelineAnalysis: join(FIXTURES_DIR, "examples/iris_pipeline/astra.yaml"),
} as const;

let _testSchema: JsonSchema | undefined;

export async function getTestSchema(): Promise<JsonSchema> {
  if (_testSchema) return _testSchema;
  _testSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as JsonSchema;
  return _testSchema;
}
