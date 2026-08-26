import { describe, expect, it, beforeAll } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
  validateAnalysisFile,
  validateUniverseFile,
} from "../src/node.js";
import { FIXTURES, getTestSchema } from "./setup.js";
import type { JsonSchema } from "../src/schema/index.js";

let schema: JsonSchema;
beforeAll(async () => {
  schema = await getTestSchema();
});

describe("schema validation: valid fixtures", () => {
  it("accepts the canonical Analysis-001 fixture", async () => {
    expect(await validateAnalysisFile(FIXTURES.validAnalysis, { schema })).toEqual([]);
  });

  it("accepts the canonical Universe-001 fixture", async () => {
    expect(await validateUniverseFile(FIXTURES.validUniverse, { schema })).toEqual([]);
  });

  it("accepts the iris example", async () => {
    expect(await validateAnalysisFile(FIXTURES.irisAnalysis, { schema })).toEqual([]);
  });

  it("accepts the iris_pipeline example", async () => {
    expect(await validateAnalysisFile(FIXTURES.irisPipelineAnalysis, { schema })).toEqual([]);
  });
});

describe("schema validation: invalid fixtures", () => {
  const invalidFiles = readdirSync(FIXTURES.invalidDir).filter((f) => f.endsWith(".yaml"));
  for (const f of invalidFiles) {
    it(`rejects ${f}`, async () => {
      const errors = await validateAnalysisFile(join(FIXTURES.invalidDir, f), { schema });
      expect(errors.length).toBeGreaterThan(0);
    });
  }
});
