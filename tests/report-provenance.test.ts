import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  indexResolvedAnalysis,
  parseResolvedAnalysis,
  traceResultProvenance,
  type Analysis,
  type Result,
} from "../src/reports/index.js";

it("keeps pins, selections and every route through a diamond, terminating cycles", () => {
  const analysis: Analysis = {
    key: "",
    folder: ".",
    tags: [],
    declares: {},
    findings: [],
    prior_insights: [],
    inputs: [{ ref: "inputs.data", path: "data", tags: [] }],
    decisions: [
      {
        ref: "decisions.method",
        tags: [],
        options: ["a", "b"].map((id) => ({ id, tags: [], insights: [] })),
      },
    ],
    universes: ["a", "b"].map((id) => ({
      ref: `universes.${id}`,
      tags: [],
      selection: { "decisions.method": id },
    })),
    outputs: ["root", "left", "right", "fit"].map((id) => ({
      ref: `outputs.${id}`,
      type: "data",
      format: "txt",
      tags: [],
      decisions: id === "fit" ? ["decisions.method"] : [],
    })),
  };
  const result = (
    id: string,
    output: string,
    inputs: Result["inputs"],
    universe?: string,
  ): Result => ({
    id,
    output: `outputs.${output}`,
    places: [],
    inputs,
    ...(universe ? { universe } : {}),
  });
  const index = indexResolvedAnalysis({
    spec_version: "0.1.0",
    schema_version: "astra-tools.resolved-analysis.v1",
    head: null,
    notes: [],
    analyses: [analysis],
    results: [
      result("root", "root", [
        { entry: "left", result: "left" },
        { entry: "right", result: "right" },
      ]),
      result("left", "left", [{ entry: "fit#a", result: "fit-a" }]),
      result("right", "right", [
        { entry: "fit#a", result: "fit-a" },
        { entry: "fit#b", result: "fit-b" },
      ]),
      result(
        "fit-a",
        "fit",
        [
          { entry: "data", input: "inputs.data" },
          { entry: "cycle", result: "root" },
        ],
        "universes.a",
      ),
      result(
        "fit-b",
        "fit",
        [{ entry: "data", input: "inputs.data" }],
        "universes.b",
      ),
    ],
  });
  const trace = traceResultProvenance(index, "root");
  expect(
    trace.decisions.map((d) => [
      d.universe,
      d.option?.id,
      d.route.map((s) => s.source.entry),
    ]),
  ).toEqual([
    ["universes.a", "a", ["left", "fit#a"]],
    ["universes.a", "a", ["right", "fit#a"]],
    ["universes.b", "b", ["right", "fit#b"]],
  ]);
  expect(trace.inputs.map((i) => i.route.map((s) => s.source.entry))).toEqual([
    ["left", "fit#a", "data"],
    ["right", "fit#a", "data"],
    ["right", "fit#b", "data"],
  ]);
  expect(traceResultProvenance(index, "unknown")).toEqual({
    decisions: [],
    inputs: [],
  });
});

function switchFixture() {
  return parseResolvedAnalysis(JSON.parse(readFileSync(resolve(
    "upstream/astra-tools/tests/report-fixtures/switch-status/resolve.json",
  ), "utf8")));
}

it("includes decisions that only select an effective input's switch case", () => {
  const index = indexResolvedAnalysis(switchFixture());
  for (const [universe, option] of [["baseline", "a"], ["alternate", "b"]]) {
    const trace = traceResultProvenance(index, `pipeline#${universe}`);
    expect(trace.decisions.map((item) => ({
      result: item.result.id,
      decision: item.decision.ref,
      universe: item.universe,
      option: item.option?.id,
      route: item.route.map((step) => step.source.entry),
    }))).toEqual([{
      result: `pipeline#${universe}`,
      decision: "decisions.route",
      universe: `universes.${universe}`,
      option,
      route: ["chosen"],
    }]);
  }
});

it("follows authored and nested case pins and terminates switch cycles", () => {
  const original = switchFixture();
  const root = original.analyses[0]!;
  const nested = {
    ref: "switches.nested",
    decision: "decisions.cold",
    cases: { a: { entry: "stale", target: "outputs.stale" } },
  };
  const report = {
    ...original,
    analyses: [{
      ...root,
      outputs: root.outputs.map((output) => output.ref === "outputs.pipeline"
        ? { ...output, inputs: [{ entry: "chosen#baseline", target: "switches.chosen", universe: "universes.baseline" }] }
        : output),
      universes: root.universes.map((universe) => universe.ref === "universes.alternate"
        ? { ...universe, selection: { ...universe.selection, "decisions.cold": "a" } }
        : universe),
      switches: [...root.switches!.map((item) => item.ref === "switches.chosen"
        ? { ...item, cases: { ...item.cases, a: { entry: "nested#alternate", target: nested.ref, universe: "universes.alternate" } } }
        : item), nested],
    }],
    results: original.results.map((result) => result.id === "pipeline#alternate"
      ? { ...result, inputs: [{ entry: "chosen#baseline", result: "stale" }] }
      : result),
  };
  const trace = traceResultProvenance(indexResolvedAnalysis(report), "pipeline#alternate");
  expect(trace.decisions.map((item) => [
    item.result.id, item.decision.ref, item.universe, item.option?.id,
    item.route.map((step) => step.source.entry),
  ])).toEqual([
    ["pipeline#alternate", "decisions.route", "universes.baseline", "a", ["chosen#baseline"]],
    ["pipeline#alternate", "decisions.cold", "universes.alternate", "a", ["chosen#baseline"]],
  ]);
  const cycling = {
    ...report,
    analyses: report.analyses.map((analysis) => ({
      ...analysis,
      switches: analysis.switches.map((item) => item.ref === nested.ref
        ? { ...item, cases: { a: { entry: "chosen#baseline", target: "switches.chosen", universe: "universes.baseline" } } }
        : item),
    })),
  };
  expect(traceResultProvenance(indexResolvedAnalysis(cycling), "pipeline#alternate").decisions).toHaveLength(2);
});
