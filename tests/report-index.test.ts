import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseResolvedAnalysis } from "../src/reports/decode.js";
import {
  indexResolvedAnalysis,
  ReportIndexError,
  type ReportIndexErrorCode,
} from "../src/reports/index-analysis.js";
import {
  RESOLVED_ANALYSIS_SCHEMA_VERSION,
  type Analysis,
  type ResolvedAnalysis,
  type Result,
} from "../src/reports/types.js";

function fixture(name: string): ResolvedAnalysis {
  const path = resolve("upstream/astra-tools/tests/report-fixtures", name, "resolve.json");
  return parseResolvedAnalysis(JSON.parse(readFileSync(path, "utf8")));
}

function analysis(key: string, fields: Partial<Analysis> = {}): Analysis {
  return {
    key, folder: ".", tags: [], declares: {}, inputs: [], outputs: [],
    decisions: [], prior_insights: [], findings: [], universes: [], ...fields,
  };
}

function report(analyses: readonly Analysis[], results: readonly Result[] = []): ResolvedAnalysis {
  return {
    spec_version: "0.1.0", schema_version: RESOLVED_ANALYSIS_SCHEMA_VERSION,
    analyses, results, notes: [],
  };
}

describe("resolved report indexes", () => {
  it.each(["driven", "switch-status"])("indexes the %s golden without changing it", (name) => {
    const candidate = fixture(name);
    const before = JSON.stringify(candidate);
    const index = indexResolvedAnalysis(candidate);
    expect([...index.analysisByKey.values()]).toEqual(candidate.analyses);
    expect([...index.resultById.values()]).toEqual(candidate.results);
    expect(index.analysisByKey.get("")).toBe(candidate.analyses[0]);
    for (const result of candidate.results) {
      expect(index.resultById.get(result.id)).toBe(result);
      expect(index.resultsByOutput.get(result.output)).toContain(result);
    }
    expect(JSON.stringify(candidate)).toBe(before);
  });

  it("groups an output's root-driven and independently pinned results in report order", () => {
    const candidate = fixture("driven");
    const index = indexResolvedAnalysis(candidate);
    const results = index.resultsByOutput.get("stage.outputs.fit")!;
    expect(results.map((result) => result.id)).toEqual([
      "stage.fit#baseline", "stage:fit#local", "stage.fit#alternate",
    ]);
    expect(results[0]).toBe(candidate.results[1]);
    expect(index.resultsByOutput.get("unknown")).toBeUndefined();
    const output = index.elementByRef.get("stage.outputs.fit")!;
    expect(output.collection).toBe("outputs");
    expect(output.analysis).toBe(candidate.analyses[1]);
    expect(output.element).toBe(candidate.analyses[1]!.outputs[0]);
    const universe = index.elementByRef.get(results[0]!.universe!)!;
    expect(universe.collection).toBe("universes");
    expect(universe.analysis).toBe(candidate.analyses[0]);
  });

  it("indexes every element collection and derives ownership from membership", () => {
    const owner = analysis("stage", {
      inputs: [{ ref: "input-ref", path: "data.csv", tags: [] }],
      outputs: [{ ref: "output-ref", type: "data", format: "csv", tags: [], decisions: [] }],
      decisions: [{ ref: "decision-ref", options: [], tags: [] }],
      prior_insights: [{ ref: "prior-ref", kind: "prior_insight", claim: "Prior", evidence: [], tags: [] }],
      findings: [{ ref: "finding-ref", kind: "finding", claim: "Finding", evidence: [], tags: [] }],
      universes: [{ ref: "universe-ref", selection: {}, tags: [] }],
    });
    const index = indexResolvedAnalysis(report([owner]));
    for (const [ref, collection] of [
      ["input-ref", "inputs"], ["output-ref", "outputs"], ["decision-ref", "decisions"],
      ["prior-ref", "prior_insights"], ["finding-ref", "findings"], ["universe-ref", "universes"],
    ]) {
      const entry = index.elementByRef.get(ref!)!;
      expect(entry.collection).toBe(collection);
      expect(entry.analysis).toBe(owner);
    }
    expect(index.elementByRef.get("unknown")).toBeUndefined();
  });

  it("preserves empty root keys, declaration aliases and prototype-named identities", () => {
    const root = analysis("", { declares: { first: "constructor", second: "constructor" } });
    const child = analysis("constructor", {
      declares: { parent: "" },
      inputs: [{ ref: "__proto__", path: "data.csv", tags: [] }],
    });
    const result: Result = { id: "constructor", output: "__proto__", places: [], inputs: [] };
    const index = indexResolvedAnalysis(report([root, child], [result]));
    expect(index.analysisByKey.get("")).toBe(root);
    expect(index.analysisByKey.get("constructor")).toBe(child);
    expect(index.elementByRef.get("__proto__")!.analysis).toBe(child);
    expect(index.resultById.get("constructor")).toBe(result);
    expect(index.analysisByKey.get("")!.declares).toBe(root.declares);
    expect(root.declares).toEqual({ first: "constructor", second: "constructor" });
    expect(child.declares.parent).toBe("");
  });

  it("retains a result with several places as one result", () => {
    const first = fixture("driven").results[0]!;
    const result = {
      ...first,
      places: [...first.places, { address: "alias", record_path: "alias.json", file_path: "alias.txt" }],
    };
    const index = indexResolvedAnalysis(report([], [result]));
    expect(index.resultById.get(result.id)).toBe(result);
    expect(index.resultsByOutput.get(result.output)).toEqual([result]);
    expect(index.resultById.get(result.id)!.places).toBe(result.places);
  });

  it.each<{ code: ReportIndexErrorCode; key: string; candidate: ResolvedAnalysis }>([
    {
      code: "DUPLICATE_ANALYSIS_KEY", key: "",
      candidate: report([analysis(""), analysis("")]),
    },
    {
      code: "DUPLICATE_ELEMENT_REF", key: "shared-ref",
      candidate: report([
        analysis("", { inputs: [{ ref: "shared-ref", path: "x", tags: [] }] }),
        analysis("stage", { universes: [{ ref: "shared-ref", selection: {}, tags: [] }] }),
      ]),
    },
    {
      code: "DUPLICATE_RESULT_ID", key: "same",
      candidate: report([], [
        { id: "same", output: "outputs.a", places: [], inputs: [] },
        { id: "same", output: "outputs.b", places: [], inputs: [] },
      ]),
    },
  ])("rejects $code instead of overwriting an identity", ({ candidate, code, key }) => {
    try {
      indexResolvedAnalysis(candidate);
      throw new Error("Expected duplicate identity rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ReportIndexError);
      expect(error).toMatchObject({ code, key });
    }
  });
});
