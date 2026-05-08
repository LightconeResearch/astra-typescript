import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadAstraSchema, type JsonSchema } from "../src/schema/index.js";

// Tests run offline against the sibling `astra-spec` checkout. Schema,
// fixtures, and example projects all come from there — we don't keep
// stale copies in this repo.
const ASTRA_SPEC = resolve(__dirname, "../../astra-spec");

export const SPEC_PATHS = {
  schema: resolve(ASTRA_SPEC, "docs/schema/astra.schema.json"),
  validFixtures: resolve(ASTRA_SPEC, "tests/data/valid"),
  invalidFixtures: resolve(ASTRA_SPEC, "tests/data/invalid"),
  examples: resolve(ASTRA_SPEC, "examples"),
};

const localSchemaUrl = pathToFileURL(SPEC_PATHS.schema).href;

let _testSchema: JsonSchema | undefined;

export async function getTestSchema(): Promise<JsonSchema> {
  if (_testSchema) return _testSchema;
  _testSchema = await loadAstraSchema({ url: localSchemaUrl, cacheDir: false });
  return _testSchema;
}
