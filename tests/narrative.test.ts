import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import {
  checkNarrativeCoverage,
  validateNarrativeAnchors,
  validateNarrativeAnchorsFile,
  validateNarrativeSections,
} from "../src/validation/narrative.js";
import { loadYaml } from "../src/helpers.js";
import { SPEC_PATHS } from "./setup.js";

const VALID = SPEC_PATHS.validFixtures;
const EXAMPLES = SPEC_PATHS.examples;

describe("narrative anchors: valid fixtures resolve", () => {
  it("Analysis-001", () => {
    const errors = validateNarrativeAnchorsFile(resolve(VALID, "Analysis-001.yaml"));
    expect(errors).toEqual([]);
  });

  it("iris example", () => {
    const errors = validateNarrativeAnchorsFile(resolve(EXAMPLES, "iris/astra.yaml"));
    expect(errors).toEqual([]);
  });
});

describe("narrative anchors: broken references error", () => {
  it("flags a broken anchor", () => {
    const data = {
      version: "1.0",
      name: "x",
      inputs: [{ id: "a", type: "data" }],
      outputs: [{ id: "o", type: "metric" }],
      narrative: {
        summary: "See [missing](#decisions.does_not_exist).",
        inputs: "in",
        outputs: "out",
      },
    };
    const errors = validateNarrativeAnchors(data);
    expect(errors.map((e) => e.code)).toContain("BROKEN_NARRATIVE_ANCHOR");
  });
});

describe("narrative section requirements", () => {
  it("requires narrative.findings when findings exist", () => {
    const data = {
      version: "1.0",
      name: "x",
      inputs: [{ id: "a", type: "data" }],
      outputs: [{ id: "o", type: "metric" }],
      narrative: { summary: "ok", inputs: "in", outputs: "out" },
      findings: {
        f1: { id: "f1", claim: "c", created_at: "2025-01-01T00:00:00Z", evidence: [] },
      },
    };
    const errors = validateNarrativeSections(data);
    expect(errors.map((e) => e.code)).toContain("NARRATIVE_SECTION_REQUIRED");
  });
});

describe("narrative coverage warnings", () => {
  it("warns about an unmentioned decision", () => {
    const data = {
      version: "1.0",
      name: "x",
      inputs: [{ id: "a", type: "data" }],
      outputs: [{ id: "o", type: "metric" }],
      narrative: { summary: "no refs here", inputs: "in", outputs: "out", methods: "no refs" },
      decisions: { lonely: { label: "L", options: { v: { label: "V" } } } },
    };
    const warnings = checkNarrativeCoverage(data);
    expect(warnings.some((w) => w.code === "NARRATIVE_UNMENTIONED")).toBe(true);
  });
});

// Bind loadYaml so the import isn't pruned (kept for future tests).
void loadYaml;
