import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadAstraSchema, type JsonSchema } from "../src/schema/index.js";

// Schema is fetched from astra-spec.org (cached on disk for re-runs).
// Fixtures and examples are vendored locally because the astra-spec
// GitHub repo is currently private and the docs site only publishes
// schema artifacts; if astra-spec is made public we can switch the
// fixture path to a fetch helper.

const SCHEMA_URL =
  process.env.ASTRA_SPEC_SCHEMA_URL ?? "https://astra-spec.org/latest/schema/astra.schema.json";

const SCHEMA_CACHE_DIR = join(tmpdir(), "astra-spec-schema-cache");

const FIXTURES_DIR = resolve(__dirname, "fixtures");

export const FIXTURES = {
  validAnalysis: join(FIXTURES_DIR, "valid/Analysis-001.yaml"),
  validUniverse: join(FIXTURES_DIR, "valid/Universe-001.yaml"),
  invalidDir: join(FIXTURES_DIR, "invalid"),
  irisAnalysis: join(FIXTURES_DIR, "examples/iris/astra.yaml"),
  irisUniverseBaseline: join(FIXTURES_DIR, "examples/iris/universes/baseline.yaml"),
  irisPipelineAnalysis: join(FIXTURES_DIR, "examples/iris_pipeline/astra.yaml"),
} as const;

let _testSchema: JsonSchema | undefined;

/** Load the ASTRA JSON Schema. Defaults to
 *  `https://astra-spec.org/latest/schema/astra.schema.json`; override with
 *  `ASTRA_SPEC_SCHEMA_URL` (e.g. for pinning a version, or pointing at a
 *  local file:// during development). */
export async function getTestSchema(): Promise<JsonSchema> {
  if (_testSchema) return _testSchema;
  _testSchema = await loadAstraSchema({ url: SCHEMA_URL, cacheDir: SCHEMA_CACHE_DIR });
  return _testSchema;
}
