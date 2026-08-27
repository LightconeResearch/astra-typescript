import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
  validateAnalysisFile,
  validateUniverseFile,
} from "../src/node.js";
import { FIXTURES } from "./setup.js";

describe("schema validation: valid fixtures", () => {
  it("accepts the canonical Analysis-001 fixture", async () => {
    expect(await validateAnalysisFile(FIXTURES.validAnalysis)).toEqual([]);
  });

  it("accepts the canonical Universe-001 fixture", async () => {
    expect(await validateUniverseFile(FIXTURES.validUniverse)).toEqual([]);
  });

  it("accepts the iris example", async () => {
    expect(await validateAnalysisFile(FIXTURES.irisAnalysis)).toEqual([]);
  });

  it("accepts the iris_pipeline example", async () => {
    expect(await validateAnalysisFile(FIXTURES.irisPipelineAnalysis)).toEqual([]);
  });
});

describe("schema validation: invalid fixtures", () => {
  const invalidFiles = readdirSync(FIXTURES.invalidDir).filter((f) => f.endsWith(".yaml"));
  for (const f of invalidFiles) {
    it(`rejects ${f}`, async () => {
      const errors = await validateAnalysisFile(join(FIXTURES.invalidDir, f));
      expect(errors.length).toBeGreaterThan(0);
    });
  }
});
