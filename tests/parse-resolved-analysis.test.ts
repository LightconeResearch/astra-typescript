import { describe, expect, it } from "vitest";

import {
  isResolvedAnalysisBundle,
  parseResolvedAnalysisBundle,
  RESOLVED_ANALYSIS_SCHEMA_VERSION,
  ResolvedAnalysisBundleValidationError,
  type ResolvedAnalysisBundle,
} from "../src/index.js";

function completeBundle(): ResolvedAnalysisBundle {
  return {
    document: {
      schemaVersion: RESOLVED_ANALYSIS_SCHEMA_VERSION,
      universe: {
        universeId: "baseline",
        description: "Baseline selections",
        availableUniverseIds: ["baseline", "alternative"],
        source: "explicit",
      },
      analysis: {
        id: "root",
        version: "0.1.0",
        name: "Transport example",
        canonicalPath: "$",
        description: "A complete resolved document",
        container: "ghcr.io/example/analysis:latest",
        tags: ["example"],
        inputs: [
          {
            id: "catalog",
            kind: "input",
            canonicalPath: "inputs.catalog",
            type: "data",
            label: "Catalog",
            description: "Input catalog",
            source: "https://example.test/catalog.csv",
            ref: "upstream",
            ref_version: "v1",
            use_outputs: ["summary"],
            from: "stage.outputs.catalog",
            resolvedFrom: "stage.outputs.catalog",
          },
        ],
        outputs: [
          {
            id: "figure",
            kind: "output",
            canonicalPath: "outputs.figure",
            type: "figure",
            active: true,
            label: "Summary figure",
            format: "svg",
            description: "Primary result",
            inputs: ["catalog"],
            decisions: ["method"],
            recipe: {
              command: "python plot.py",
              container: "ghcr.io/example/plot:latest",
              resources: {
                cpus: 2,
                gpus: 1,
                memory: "4 GiB",
                time_limit: "10 min",
                disk: "1 GiB",
              },
            },
            from: "stage.outputs.figure",
            resolvedFrom: "stage.outputs.figure",
            when: ["method.robust"],
            provenance: {
              inputPaths: ["inputs.catalog"],
              decisionPaths: ["decisions.method"],
            },
            artifact: { byteSize: 4096 },
          },
        ],
        decisions: [
          {
            id: "method",
            kind: "decision",
            canonicalPath: "decisions.method",
            label: "Method",
            active: true,
            rationale: "Stable under perturbations",
            tags: ["modelling"],
            default: "robust",
            from: "stage.decisions.method",
            resolvedFrom: "stage.decisions.method",
            when: ["sample.complete"],
            selectedOptionId: "robust",
            options: [
              {
                id: "robust",
                label: "Robust",
                description: "Robust estimator",
                insights: ["precedent"],
                incompatible_with: ["fast"],
                requires: ["catalog"],
                excluded: false,
                excluded_reason: "",
                resolvedInsightPaths: ["prior_insights.precedent"],
              },
            ],
          },
        ],
        prior_insights: [
          {
            id: "precedent",
            kind: "prior_insight",
            canonicalPath: "prior_insights.precedent",
            label: "Precedent",
            claim: "Prior work supports the method.",
            created_at: "2026-01-01T00:00:00Z",
            snapshot: "snapshot-1",
            source_commit: "abc123",
            derived: false,
            scope: "global",
            tags: ["literature"],
            notes: "Reviewed",
            evidence: [
              {
                id: "paper",
                doi: "10.1234/example",
                artifact: "figure",
                version: 2,
                snapshot: "snapshot-1",
                source_commit: "abc123",
                quote: {
                  exact: "Evidence text",
                  prefix: "Before",
                  suffix: "After",
                },
                location: { value: "section-2", page: 4 },
                resolvedOutputPath: "outputs.figure",
              },
            ],
          },
        ],
        findings: [
          {
            id: "result",
            kind: "finding",
            canonicalPath: "findings.result",
            claim: "The method is stable.",
            created_at: "2026-01-02T00:00:00Z",
            evidence: [],
          },
        ],
        analyses: [
          {
            id: "stage",
            version: "0.1.0",
            name: "Stage",
            canonicalPath: "stage",
            inputs: [],
            outputs: [],
            decisions: [],
            prior_insights: [],
            findings: [],
            analyses: [],
          },
        ],
      },
    },
    bindings: [
      {
        outputPath: "outputs.figure",
        path: "results/baseline/figure.svg",
        cacheToken: "opaque-token",
      },
    ],
  };
}

function transportClone(): unknown {
  return JSON.parse(JSON.stringify(completeBundle()));
}

describe("resolved analysis bundle decoding", () => {
  it("narrows and returns a complete JSON-round-tripped bundle unchanged", () => {
    const candidate: unknown = transportClone();

    expect(isResolvedAnalysisBundle(candidate)).toBe(true);
    if (!isResolvedAnalysisBundle(candidate)) throw new Error("expected a valid bundle");
    expect(candidate.document.analysis.outputs[0]?.artifact?.byteSize).toBe(4096);

    expect(parseResolvedAnalysisBundle(candidate)).toBe(candidate);
  });

  it("allows additive fields for forward-compatible producers", () => {
    const candidate = transportClone() as Record<string, unknown>;
    candidate.producer = { name: "external-integration" };
    const document = candidate.document as Record<string, unknown>;
    document.futureDocumentMetadata = true;

    expect(isResolvedAnalysisBundle(candidate)).toBe(true);
  });

  it("accepts shared non-recursive values from an in-memory resolver result", () => {
    const candidate = completeBundle();
    const output = candidate.document.analysis.outputs[0]!;
    candidate.document.analysis.outputs.push({
      ...output,
      id: "figure-alias",
      canonicalPath: "outputs.figure-alias",
      provenance: output.provenance,
    });

    expect(output.provenance).toBe(candidate.document.analysis.outputs[1]?.provenance);
    expect(isResolvedAnalysisBundle(candidate)).toBe(true);
  });

  it("reports the unsupported document schema with a stable path", () => {
    const candidate = transportClone() as {
      document: { schemaVersion: string };
    };
    candidate.document.schemaVersion = "astra-resolved-analysis.v2";

    expect(isResolvedAnalysisBundle(candidate)).toBe(false);
    expect(() => parseResolvedAnalysisBundle(candidate)).toThrowError(
      ResolvedAnalysisBundleValidationError,
    );

    try {
      parseResolvedAnalysisBundle(candidate);
    } catch (error) {
      expect(error).toBeInstanceOf(ResolvedAnalysisBundleValidationError);
      if (!(error instanceof ResolvedAnalysisBundleValidationError)) throw error;
      expect(error.message).toContain("$.document.schemaVersion");
      expect(error.issues).toEqual([
        {
          code: "UNSUPPORTED_SCHEMA_VERSION",
          path: "$.document.schemaVersion",
          message: 'Expected "astra-resolved-analysis.v1"',
        },
      ]);
    }
  });

  it("distinguishes a malformed schema-version type from an unsupported version", () => {
    const candidate = transportClone() as {
      document: { schemaVersion: unknown };
    };
    candidate.document.schemaVersion = 1;

    try {
      parseResolvedAnalysisBundle(candidate);
    } catch (error) {
      expect(error).toBeInstanceOf(ResolvedAnalysisBundleValidationError);
      if (!(error instanceof ResolvedAnalysisBundleValidationError)) throw error;
      expect(error.issues).toContainEqual({
        code: "INVALID_TYPE",
        path: "$.document.schemaVersion",
        message: "Expected a string",
      });
    }
  });

  it("enforces root and child analysis required fields independently", () => {
    const missingRootName = transportClone() as {
      document: { analysis: { name?: string } };
    };
    delete missingRootName.document.analysis.name;
    expect(isResolvedAnalysisBundle(missingRootName)).toBe(false);

    const childWithoutOptionalMetadata = transportClone() as {
      document: {
        analysis: {
          id?: string;
          analyses: Array<{ name?: string; version?: string }>;
        };
      };
    };
    delete childWithoutOptionalMetadata.document.analysis.id;
    delete childWithoutOptionalMetadata.document.analysis.analyses[0]!.name;
    delete childWithoutOptionalMetadata.document.analysis.analyses[0]!.version;
    expect(isResolvedAnalysisBundle(childWithoutOptionalMetadata)).toBe(true);

    const childWithoutId = transportClone() as {
      document: { analysis: { analyses: Array<{ id?: string }> } };
    };
    delete childWithoutId.document.analysis.analyses[0]!.id;
    expect(isResolvedAnalysisBundle(childWithoutId)).toBe(false);
  });

  it("collects nested structural issues with precise paths", () => {
    const candidate = transportClone() as {
      document: {
        universe: { availableUniverseIds: unknown[] };
        analysis: {
          outputs: Array<{ active?: unknown; artifact?: { byteSize: unknown } }>;
        };
      };
      bindings: Array<{ cacheToken?: unknown }>;
    };
    candidate.document.universe.availableUniverseIds[1] = 42;
    candidate.document.analysis.outputs[0]!.active = "yes";
    candidate.document.analysis.outputs[0]!.artifact!.byteSize = -1;
    delete candidate.bindings[0]!.cacheToken;

    try {
      parseResolvedAnalysisBundle(candidate);
      throw new Error("expected parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolvedAnalysisBundleValidationError);
      if (!(error instanceof ResolvedAnalysisBundleValidationError)) throw error;
      expect(error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "INVALID_TYPE",
            path: "$.document.universe.availableUniverseIds[1]",
          }),
          expect.objectContaining({
            code: "INVALID_TYPE",
            path: "$.document.analysis.outputs[0].active",
          }),
          expect.objectContaining({
            code: "INVALID_VALUE",
            path: "$.document.analysis.outputs[0].artifact.byteSize",
          }),
          expect.objectContaining({
            code: "MISSING_PROPERTY",
            path: "$.bindings[0].cacheToken",
          }),
        ]),
      );
      expect(error.issues).toHaveLength(4);
    }
  });

  it.each([null, [], "bundle", 42])("rejects a non-object bundle: %j", (candidate) => {
    expect(isResolvedAnalysisBundle(candidate)).toBe(false);
    expect(() => parseResolvedAnalysisBundle(candidate)).toThrowError(
      ResolvedAnalysisBundleValidationError,
    );
  });

  it("rejects cycles in the recursive analysis hierarchy", () => {
    const candidate = completeBundle();
    candidate.document.analysis.analyses.push(candidate.document.analysis);

    expect(isResolvedAnalysisBundle(candidate)).toBe(false);
    try {
      parseResolvedAnalysisBundle(candidate);
    } catch (error) {
      expect(error).toBeInstanceOf(ResolvedAnalysisBundleValidationError);
      if (!(error instanceof ResolvedAnalysisBundleValidationError)) throw error;
      expect(error.issues).toContainEqual({
        code: "CYCLIC_ANALYSIS",
        path: "$.document.analysis.analyses[1]",
        message: "Analysis hierarchy must not contain a cycle",
      });
    }
  });
});
