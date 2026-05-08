import { describe, expect, it } from "vitest";

import {
  checkNarrativeCoverage,
  validateNarrativeAnchors,
  validateNarrativeAnchorsFile,
  validateNarrativeSections,
} from "../src/validation/narrative.js";
import { FIXTURES } from "./setup.js";

describe("narrative anchors: valid fixtures resolve", () => {
  it("Analysis-001", () => {
    expect(validateNarrativeAnchorsFile(FIXTURES.validAnalysis)).toEqual([]);
  });

  it("iris example", () => {
    expect(validateNarrativeAnchorsFile(FIXTURES.irisAnalysis)).toEqual([]);
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

