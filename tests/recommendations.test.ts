import { describe, expect, it } from "vitest";

import { collectRecommendations, validateAnalysis } from "../src/index.js";

const analysis = (outputs: unknown[], extra: Record<string, unknown> = {}) => ({
  version: "1.0",
  name: "Recommendations",
  inputs: [{ id: "catalog", type: "data", source: "data/catalog.csv" }],
  outputs,
  ...extra,
});

describe("collectRecommendations", () => {
  it("reports an output with no format", () => {
    const messages = collectRecommendations(analysis([{ id: "result", type: "metric" }]));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("result");
    expect(messages[0]).toContain("0.1.0");
  });

  it("says nothing when the format is declared", () => {
    expect(
      collectRecommendations(analysis([{ id: "result", type: "metric", format: "json" }])),
    ).toEqual([]);
  });

  it("never reports a re-export", () => {
    // An alias inherits `format` and is forbidden from declaring one, so
    // asking it for a format would be asking for a schema violation.
    expect(collectRecommendations(analysis([{ id: "result", from: "child.result" }]))).toEqual([]);
  });

  it("names a nested output by its qualified id", () => {
    const messages = collectRecommendations(
      analysis([], { analyses: { child: { outputs: [{ id: "result", type: "metric" }] } } }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("child.result");
  });

  it("names every offender in one message", () => {
    const messages = collectRecommendations(
      analysis([
        { id: "a", type: "metric" },
        { id: "b", type: "figure", format: "png" },
        { id: "c", type: "table" },
      ]),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("2 outputs");
    expect(messages[0]).toContain("a");
    expect(messages[0]).toContain("c");
  });

  it("does not make the analysis invalid", () => {
    // The whole contract of `recommended`: advisory, never fatal.
    const data = analysis([{ id: "result", type: "metric" }]);
    expect(validateAnalysis(data)).toEqual([]);
    expect(collectRecommendations(data)).not.toEqual([]);
  });
});
