import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseResolvedAnalysis } from "../src/reports/decode.js";
import { indexResolvedAnalysis } from "../src/reports/index-analysis.js";
import {
  getCitedResults,
  getDeclaredAnalysis,
  getEvidence,
  getEvidenceOutput,
  getEvidenceBindings,
  getResult,
  getResultOwner,
  getSelectedOption,
  selectResult,
  walkAnalyses,
  walkResultDependencies,
} from "../src/reports/selectors.js";
import type { Analysis, ResolvedAnalysis } from "../src/reports/types.js";

function fixture(name = "driven"): ResolvedAnalysis {
  return parseResolvedAnalysis(JSON.parse(readFileSync(resolve(
    "upstream/astra-tools/tests/report-fixtures", name, "resolve.json",
  ), "utf8")));
}

function replaceAnalysis(
  report: ResolvedAnalysis,
  key: string,
  update: (analysis: Analysis) => Analysis,
): ResolvedAnalysis {
  return { ...report, analyses: report.analyses.map((analysis) => analysis.key === key ? update(analysis) : analysis) };
}

describe("declaration navigation", () => {
  it("follows the golden's parent cycle through the root's empty key", () => {
    const report = fixture();
    const index = indexResolvedAnalysis(report);
    expect(getDeclaredAnalysis(index, "", "stage")).toBe(report.analyses[1]);
    expect(getDeclaredAnalysis(index, "stage", "parent")).toBe(report.analyses[0]);
    expect([...walkAnalyses(index)]).toEqual(report.analyses);
    expect([...walkAnalyses(index, "stage")].map((analysis) => analysis.key)).toEqual(["stage", ""]);
  });

  it("visits nodes once in declaration order while retaining all aliases", () => {
    const original = fixture();
    const other = {
      ...original.analyses[1]!, key: "other", folder: "other", declares: {},
      decisions: [], outputs: [], universes: [],
    };
    const report = replaceAnalysis({ ...original, analyses: [...original.analyses, other] }, "", (root) => ({
      ...root,
      declares: { second: "other", first: "stage", alias: "other", constructor: "stage", missing: "absent" },
    }));
    const index = indexResolvedAnalysis(report);
    expect([...walkAnalyses(index)].map((analysis) => analysis.key)).toEqual(["", "other", "stage"]);
    expect(getDeclaredAnalysis(index, "", "second")).toBe(getDeclaredAnalysis(index, "", "alias"));
    expect(getDeclaredAnalysis(index, "", "constructor")?.key).toBe("stage");
    expect(index.analysisByKey.get("")!.declares.alias).toBe("other");
    expect(getDeclaredAnalysis(index, "", "toString")).toBeUndefined();
    expect(getDeclaredAnalysis(index, "", "missing")).toBeUndefined();
    expect(getDeclaredAnalysis(index, "absent", "first")).toBeUndefined();
    expect([...walkAnalyses(index, "absent")]).toEqual([]);
  });
});

describe("result ownership and universe selection", () => {
  it("distinguishes a driven result's owner from its output's declaring analysis", () => {
    const report = fixture();
    const index = indexResolvedAnalysis(report);
    expect(index.elementByRef.get("stage.outputs.fit")?.analysis.key).toBe("stage");
    expect(getResultOwner(index, "stage.fit#baseline")).toBe(report.analyses[0]);
    expect(getResultOwner(index, "stage:fit#local")).toBe(report.analyses[1]);
    expect(getResultOwner(index, "shared")).toBe(report.analyses[0]);
    expect(getResultOwner(index, "absent")).toBeUndefined();
  });

  it("derives ownership from membership rather than parsing result IDs", () => {
    const original = fixture();
    const varying = original.results.find((result) => result.id === "stage.fit#baseline")!;
    const once = original.results.find((result) => result.id === "shared")!;
    const report = { ...original, results: [
      { ...varying, id: "opaque" },
      { ...once, id: "looks:foreign#but_is_once" },
      { ...varying, id: "unowned", universe: "unknown" },
      { ...once, id: "undeclared", output: "unknown" },
    ] };
    const index = indexResolvedAnalysis(report);
    expect(getResultOwner(index, "opaque")?.key).toBe("");
    expect(getResultOwner(index, "looks:foreign#but_is_once")?.key).toBe("");
    expect(getResultOwner(index, "unowned")).toBeUndefined();
    expect(getResultOwner(index, "undeclared")).toBeUndefined();
  });

  it("keeps exact lookup separate from a known universe's once-built fallback", () => {
    const index = indexResolvedAnalysis(fixture());
    expect(getResult(index, "stage.outputs.fit", "universes.baseline")?.id).toBe("stage.fit#baseline");
    expect(getResult(index, "stage.outputs.fit", "stage.universes.local")?.id).toBe("stage:fit#local");
    expect(getResult(index, "stage.outputs.fit")).toBeUndefined();
    expect(getResult(index, "outputs.shared")?.id).toBe("shared");
    expect(getResult(index, "outputs.shared", "universes.baseline")).toBeUndefined();
    expect(selectResult(index, "outputs.shared", "universes.baseline")?.id).toBe("shared");
    expect(selectResult(index, "stage.outputs.fit", "universes.alternate")?.id).toBe("stage.fit#alternate");
    expect(selectResult(index, "outputs.shared", "unknown")).toBeUndefined();
    expect(selectResult(index, "unknown", "universes.baseline")).toBeUndefined();
    expect(selectResult(index, "outputs.shared", "outputs.comparison")).toBeUndefined();
  });

  it("reads effective selections across analyses and returns the original options", () => {
    const report = fixture();
    const index = indexResolvedAnalysis(report);
    const decision = report.analyses[1]!.decisions[0]!;
    expect(getSelectedOption(index, "universes.baseline", decision.ref)).toBe(decision.options[0]);
    expect(getSelectedOption(index, "universes.alternate", decision.ref)).toBe(decision.options[1]);
    expect(getSelectedOption(index, "stage.universes.local", decision.ref)).toBe(decision.options[0]);
    expect(getSelectedOption(index, "unknown", decision.ref)).toBeUndefined();
    expect(getSelectedOption(index, "universes.baseline", "outputs.shared")).toBeUndefined();
  });

  it("does not infer a default or accept an inherited selection", () => {
    const report = replaceAnalysis(fixture(), "", (root) => ({
      ...root,
      universes: root.universes.map((universe) => ({
        ...universe,
        selection: Object.create({ "stage.decisions.method": "a" }) as Readonly<Record<string, string>>,
      })),
    }));
    const index = indexResolvedAnalysis(report);
    expect(getSelectedOption(index, "universes.baseline", "stage.decisions.method")).toBeUndefined();
    expect(getSelectedOption(index, "universes.alternate", "stage.decisions.method")).toBeUndefined();
  });
});

describe("result dependencies", () => {
  it("follows pins across universes and visits shared results only once", () => {
    const index = indexResolvedAnalysis(fixture());
    const dependencies = [...walkResultDependencies(index, "comparison#baseline")];
    expect(dependencies.map((result) => result.id)).toEqual([
      "shared", "stage.fit#baseline", "stage:fit#local",
    ]);
    expect(dependencies.map((result) => result.universe)).toEqual([
      undefined, "universes.baseline", "stage.universes.local",
    ]);
    expect(dependencies[0]).toBe(index.resultById.get("shared"));
    expect([...walkResultDependencies(index, "shared")]).toEqual([]);
    expect([...walkResultDependencies(index, "unknown")]).toEqual([]);
  });

  it("uses depth-first input order and terminates on malformed cycles or missing targets", () => {
    const original = fixture();
    const template = original.results[0]!;
    const report = { ...original, results: [
      { ...template, id: "seed", inputs: [
        { entry: "b", result: "b" }, { entry: "c", result: "c" },
        { entry: "missing", result: "unknown" }, { entry: "file", input: "inputs.seed" },
      ] },
      { ...template, id: "b", inputs: [{ entry: "c", result: "c" }, { entry: "cycle", result: "seed" }] },
      { ...template, id: "c", inputs: [] },
    ] };
    const index = indexResolvedAnalysis(report);
    expect([...walkResultDependencies(index, "seed")].map((result) => result.id)).toEqual(["b", "c"]);
  });
});

describe("evidence identity and citations", () => {
  it("uses the insight ref and zero-based index, preserving authored pins", () => {
    const report = fixture();
    const index = indexResolvedAnalysis(report);
    const evidence = report.analyses[0]!.findings[0]!.evidence;
    expect(getEvidence(index, "findings.fit", 0)).toBe(evidence[0]);
    expect(getEvidence(index, "findings.fit", 1)?.artifact).toBe("stage.fit#local");
    expect(getCitedResults(index, "findings.fit", 1).map((result) => result.id)).toEqual(["stage:fit#local"]);
    for (const position of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 2]) {
      expect(getEvidence(index, "findings.fit", position)).toBeUndefined();
    }
    expect(getEvidence(index, "unknown", 0)).toBeUndefined();
    expect(getEvidence(index, "outputs.shared", 0)).toBeUndefined();
  });

  it("retains both once-built switch citations and the target of empty evidence", () => {
    const index = indexResolvedAnalysis(fixture("switch-status"));
    const cited = getCitedResults(index, "findings.branches", 0);
    expect(cited.map((result) => result.id)).toEqual(["present", "stale"]);
    expect(cited.every((result) => result.universe === undefined)).toBe(true);
    expect(getCitedResults(index, "findings.branches", 1).map((result) => result.id)).toEqual(["present"]);
    expect(getEvidence(index, "findings.branches", 2)?.artifact).toBe("dormant");
    expect(getCitedResults(index, "findings.branches", 2)).toEqual([]);
    expect(getEvidenceOutput(index, "findings.branches", 2)).toBe(index.elementByRef.get("outputs.dormant")?.element);
    expect(getEvidenceOutput(index, "findings.branches", 0)).toBeUndefined();
    expect(getCitedResults(index, "unknown", 0)).toEqual([]);
  });

  it("resolves concrete authored targets through aliases, parent cycles and optional pins", () => {
    const original = fixture();
    const withAlias = replaceAnalysis(original, "", (root) => ({
      ...root, declares: { ...root.declares, alias: "stage", constructor: "stage" },
    }));
    const report = replaceAnalysis(withAlias, "stage", (stage) => ({
      ...stage,
      findings: [{
        ...original.analyses[0]!.findings[0]!, ref: "stage.findings.scoped",
        evidence: ["fit", "parent.shared", "parent.alias.fit#local", "parent.constructor.parent.alias.fit"].map((artifact) => ({ artifact, cites: [] })),
      }],
    }));
    const index = indexResolvedAnalysis(report);
    const fit = index.elementByRef.get("stage.outputs.fit")?.element;
    expect(getEvidenceOutput(index, "findings.fit", 0)).toBe(fit);
    expect(getEvidenceOutput(index, "findings.fit", 1)).toBe(fit);
    expect(getEvidenceOutput(index, "stage.findings.scoped", 0)).toBe(fit);
    expect(getEvidenceOutput(index, "stage.findings.scoped", 1)).toBe(index.elementByRef.get("outputs.shared")?.element);
    expect(getEvidenceOutput(index, "stage.findings.scoped", 2)).toBe(fit);
    expect(getEvidenceOutput(index, "stage.findings.scoped", 3)).toBe(fit);
  });

  it("leaves malformed addresses, missing outputs and non-artifact evidence unresolved", () => {
    const original = fixture();
    const targets = ["", "stage..fit", ".stage.fit", "stage.fit.", "stage.fit#", "stage.fit#local#again", "stage.fit#Bad", "stage.fit\n", "stage.fit#local\n", "Stage.fit", "stage.fit-bad", "stage:fit", "missing.fit", "outputs.shared", "seed", "stage.method"];
    const report = replaceAnalysis(original, "", (root) => ({
      ...root,
      findings: [{ ...root.findings[0]!, evidence: [...targets.map((artifact) => ({ artifact })), { doi: "10.1234/example" }] }],
    }));
    const index = indexResolvedAnalysis(report);
    for (let position = 0; position <= targets.length; position += 1) {
      expect(getEvidenceOutput(index, "findings.fit", position)).toBeUndefined();
    }
    expect(getEvidenceOutput(index, "unknown", 0)).toBeUndefined();
    expect(getEvidenceOutput(index, "outputs.shared", 0)).toBeUndefined();
    expect(getEvidenceOutput(index, "findings.fit", -1)).toBeUndefined();
  });

  it("also exposes prior insights and DOI evidence without inventing result citations", () => {
    const report = replaceAnalysis(fixture(), "", (root) => ({
      ...root,
      prior_insights: [{
        ...root.findings[0]!, ref: "prior_insights.paper", kind: "prior_insight",
        evidence: [{ doi: "10.1234/example" }],
      }],
    }));
    const index = indexResolvedAnalysis(report);
    expect(getEvidence(index, "prior_insights.paper", 0)).toBe(report.analyses[0]!.prior_insights[0]!.evidence[0]);
    expect(getCitedResults(index, "prior_insights.paper", 0)).toEqual([]);
  });

  it("preserves citation order while skipping dangling result IDs", () => {
    const report = replaceAnalysis(fixture("switch-status"), "", (root) => ({
      ...root,
      findings: [{ ...root.findings[0]!, evidence: [{ cites: ["stale", "unknown", "present"] }] }],
    }));
    const index = indexResolvedAnalysis(report);
    expect(getCitedResults(index, "findings.branches", 0).map((result) => result.id)).toEqual(["stale", "present"]);
  });
});

it("selects evidence bindings without dropping pinned citations", () => {
  const index = indexResolvedAnalysis(fixture("switch-status"));
  const evidence = getEvidence(index, "findings.branches", 0)!;
  expect(evidence.bindings?.length).toBeGreaterThan(1);
  for (const binding of evidence.bindings!) {
    expect(getEvidenceBindings(index, "findings.branches", 0, binding.universe)).toEqual([binding]);
  }
  const pinned = getEvidence(index, "findings.branches", 1)!;
  expect(pinned.artifact).toContain("#");
  expect(getEvidenceBindings(index, "findings.branches", 1, "universes.other")).toEqual(pinned.bindings);
  expect(getEvidenceBindings(index, "unknown", 0)).toBeUndefined();
});
