import { expect, it } from "vitest";
import {
  indexResolvedAnalysis,
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
