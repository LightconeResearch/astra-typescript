import { describe, expect, it } from "vitest";

import {
  collectCitedDois,
  normalizeDoi,
  type ResolvedAnalysisDocument,
  type ResolvedAnalysisNode,
} from "../src/index.js";

function analysis(
  canonicalPath: string,
  doi?: string,
  children: ResolvedAnalysisNode[] = [],
): ResolvedAnalysisNode {
  return {
    canonicalPath,
    inputs: [],
    outputs: [],
    decisions: [],
    prior_insights: doi ? [{
      id: `insight_${canonicalPath.replaceAll(".", "_").replace("$", "root")}`,
      kind: "prior_insight",
      canonicalPath: `${canonicalPath === "$" ? "" : `${canonicalPath}.`}prior_insights.citation`,
      claim: "Cited claim",
      created_at: "2026-01-01T00:00:00Z",
      evidence: [{ id: "source", doi }],
    }] : [],
    findings: [],
    analyses: children.map((child) => ({ ...child, id: child.canonicalPath.split(".").at(-1)! })),
  };
}

describe("normalizeDoi", () => {
  it("normalizes labels, resolver URLs, whitespace, and case", () => {
    expect(normalizeDoi(" DOI: https://doi.org/10.1234/Example ")).toBe(
      "10.1234/example",
    );
  });
});

describe("collectCitedDois", () => {
  it("collects unique citations recursively in document order", () => {
    const document: ResolvedAnalysisDocument = {
      schemaVersion: "astra-resolved-analysis.v1",
      universe: {
        universeId: "default",
        availableUniverseIds: [],
        source: "none",
      },
      analysis: analysis("$", "10.1234/Example", [
        analysis("stage", "10.5678/Nested"),
        analysis("repeat", "10.1234/example"),
      ]),
    };
    document.analysis.findings.push({
      id: "result",
      kind: "finding",
      canonicalPath: "findings.result",
      claim: "Finding with another citation",
      created_at: "2026-01-01T00:00:00Z",
      evidence: [{ id: "source", doi: "doi:10.9012/Finding" }],
    });

    expect(collectCitedDois(document)).toEqual([
      "10.1234/example",
      "10.9012/finding",
      "10.5678/nested",
    ]);
  });
});
