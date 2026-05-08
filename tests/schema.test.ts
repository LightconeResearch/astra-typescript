import { describe, expect, it, beforeAll } from "vitest";
import { resolve } from "node:path";
import { readdirSync } from "node:fs";

import {
  validateAnalysisFile,
  validateUniverseFile,
} from "../src/validation/schema.js";
import { SPEC_PATHS, getTestSchema } from "./setup.js";
import type { JsonSchema } from "../src/schema/index.js";

let schema: JsonSchema;
beforeAll(async () => {
  schema = await getTestSchema();
});

describe("schema validation: valid fixtures", () => {
  it("accepts the canonical Analysis-001 fixture", async () => {
    const errors = await validateAnalysisFile(
      resolve(SPEC_PATHS.validFixtures, "Analysis-001.yaml"),
      { schema },
    );
    expect(errors).toEqual([]);
  });

  it("accepts the canonical Universe-001 fixture", async () => {
    const errors = await validateUniverseFile(
      resolve(SPEC_PATHS.validFixtures, "Universe-001.yaml"),
      { schema },
    );
    expect(errors).toEqual([]);
  });

  it("accepts the iris example", async () => {
    const errors = await validateAnalysisFile(
      resolve(SPEC_PATHS.examples, "iris/astra.yaml"),
      { schema },
    );
    expect(errors).toEqual([]);
  });

  it("accepts the iris_pipeline example", async () => {
    const errors = await validateAnalysisFile(
      resolve(SPEC_PATHS.examples, "iris_pipeline/astra.yaml"),
      { schema },
    );
    expect(errors).toEqual([]);
  });
});

describe("schema validation: invalid fixtures", () => {
  const invalidFiles = readdirSync(SPEC_PATHS.invalidFixtures).filter((f) => f.endsWith(".yaml"));
  for (const f of invalidFiles) {
    it(`rejects ${f}`, async () => {
      const errors = await validateAnalysisFile(resolve(SPEC_PATHS.invalidFixtures, f), { schema });
      expect(errors.length).toBeGreaterThan(0);
    });
  }
});
