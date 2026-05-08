import { describe, expect, it } from "vitest";

import {
  validateAnalysis,
  semanticValidateAnalysisFile,
  validateUniverse,
  SemanticError,
} from "../src/validation/semantic.js";
import { loadYaml } from "../src/helpers.js";
import { FIXTURES } from "./setup.js";

const codes = (errs: SemanticError[]): string[] => errs.map((e) => e.code);

describe("semantic validation: valid fixtures pass cleanly", () => {
  it("Analysis-001 has no semantic errors", () => {
    expect(semanticValidateAnalysisFile(FIXTURES.validAnalysis)).toEqual([]);
  });

  it("iris example has no semantic errors", () => {
    expect(semanticValidateAnalysisFile(FIXTURES.irisAnalysis)).toEqual([]);
  });

  it("iris_pipeline example has no semantic errors", () => {
    expect(semanticValidateAnalysisFile(FIXTURES.irisPipelineAnalysis)).toEqual([]);
  });
});

describe("semantic validation: targeted negative cases", () => {
  it("flags duplicate input IDs", () => {
    const errors = validateAnalysis({
      version: "1.0",
      name: "x",
      inputs: [
        { id: "a", type: "data" },
        { id: "a", type: "data" },
      ],
      outputs: [{ id: "out", type: "metric" }],
    });
    expect(codes(errors)).toContain("DUPLICATE_INPUT");
  });

  it("flags an invalid default option", () => {
    const errors = validateAnalysis({
      version: "1.0",
      name: "x",
      inputs: [{ id: "a", type: "data" }],
      outputs: [{ id: "out", type: "metric" }],
      decisions: {
        choice: { label: "Choice", default: "missing", options: { ok: { label: "OK" } } },
      },
    });
    expect(codes(errors)).toContain("INVALID_DEFAULT");
  });

  it("flags an unknown command-template input", () => {
    const errors = validateAnalysis({
      version: "1.0",
      name: "x",
      inputs: [{ id: "a", type: "data" }],
      outputs: [
        {
          id: "out",
          type: "metric",
          inputs: ["a"],
          recipe: { command: "run --in {inputs.a} --bad {inputs.b}" },
        },
      ],
    });
    expect(codes(errors)).toContain("UNDECLARED_TEMPLATE_REF");
  });

  it("detects output dependency cycles", () => {
    const errors = validateAnalysis({
      version: "1.0",
      name: "x",
      inputs: [],
      outputs: [
        { id: "a", type: "data", inputs: ["b"], recipe: { command: "x" } },
        { id: "b", type: "data", inputs: ["a"], recipe: { command: "x" } },
      ],
    });
    expect(codes(errors)).toContain("OUTPUT_CYCLE");
  });

  it("rejects Decision.from with descent segments", () => {
    const errors = validateAnalysis({
      version: "1.0",
      name: "x",
      inputs: [{ id: "a", type: "data" }],
      outputs: [{ id: "o", type: "metric" }],
      decisions: { d: { label: "D", options: { v: { label: "V" } } } },
      analyses: {
        child: {
          inputs: [{ id: "a", from: "../a" }],
          outputs: [{ id: "co", type: "metric" }],
          decisions: { dc: { from: "../d.v" } },
        },
      },
    });
    expect(codes(errors)).toContain("INVALID_DECISION_FROM");
  });
});

describe("universe validation", () => {
  it("validates the canonical universe against the iris analysis", () => {
    const errors = validateUniverse(loadYaml(FIXTURES.irisUniverseBaseline), loadYaml(FIXTURES.irisAnalysis));
    expect(errors).toEqual([]);
  });

  it("flags a universe that selects an unknown decision", () => {
    const universe = { id: "u", decisions: { not_a_decision: "x" } };
    const errors = validateUniverse(universe, loadYaml(FIXTURES.irisAnalysis));
    expect(codes(errors)).toContain("UNKNOWN_DECISION");
  });
});
