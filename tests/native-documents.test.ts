import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadAnalysisDocument,
  loadJson,
  checkRecordDocument,
} from "../src/engine/documents.js";
import { fill } from "../src/engine/grammar.js";
const bytes = (s: string) => new TextEncoder().encode(s);
const data = resolve("upstream/astra-spec/tests/data");
describe("native ASTRA document contract", () => {
  for (const validity of ["valid", "invalid"]) {
    const paths = readdirSync(resolve(data, validity)).filter((p) =>
      /\.(yaml|json)$/.test(p),
    );
    it.each(paths)(`${validity} %s`, (name) => {
      const path = resolve(data, validity, name),
        content = readFileSync(path);
      const result = name.endsWith(".json")
        ? checkRecordDocument(content, name)
        : loadAnalysisDocument(content, name);
      const found = [
        ...new Set(
          result.diagnostics.map((d) =>
            JSON.stringify([d.location.pointer, d.code]),
          ),
        ),
      ].sort();
      if (validity === "valid") expect(found).toEqual([]);
      else {
        const header = (
          name.endsWith(".json")
            ? readFileSync(path.replace(/\.json$/, ".header"))
            : content
        )
          .toString("ascii")
          .split("\n");
        const code = /^# rule: (\S+)/.exec(header[0]!)![1]!,
          at = /^# fails at: (\S+)/.exec(header[1]!)![1]!,
          also = /^# also: (\S+) at (\S+)/.exec(header[2] ?? "");
        const pointer = (value: string) =>
          ["(root)", "parse"].includes(value) ? "" : value;
        const expected = [JSON.stringify([pointer(at), code])];
        if (also) expected.push(JSON.stringify([pointer(also[2]!), also[1]]));
        expect(
          found,
          result.diagnostics.map((d) => d.code + ":" + d.message).join("\n"),
        ).toEqual([...new Set(expected)].sort());
      }
    });
  }
  it("rejects duplicate and nonJSON YAML values", () => {
    for (const text of [
      "a: 1\na: 2\n",
      "a: .nan\n",
      "? [a,b]\n: x\n",
      "a: &a [*a]\n",
      "a: !!set {x: null}\n",
    ]) {
      expect(
        loadAnalysisDocument(bytes(text), "astra.yaml").diagnostics[0]?.code,
      ).toBe("INVALID_SYNTAX");
    }
  });
  it("records source positions and unsupported minor versions", () => {
    const result = loadAnalysisDocument(
      bytes('spec_version: "0.0.14"\n'),
      "astra.yaml",
    );
    expect(result.diagnostics[0]).toMatchObject({
      code: "UNSUPPORTED_SPEC_VERSION",
      location: { pointer: "/spec_version", line: 1, column: 15 },
    });
  });
  it("checks JSON records without accepting duplicates or nonfinite numbers", () => {
    for (const text of ['{"x":1,"x":2}', '{"x":1e999}'])
      expect(() => loadJson(bytes(text))).toThrow();
    expect(
      checkRecordDocument(bytes("[]"), "record.json").diagnostics[0]?.code,
    ).toBe("WRONG_TYPE");
  });
  it.each([
    ["ProvenanceRecord-220-trailing-comma.json", 13, 25],
    ["ProvenanceRecord-221-size-nan.json", undefined, undefined],
    ["ProvenanceRecord-226-yaml-block-form.json", 1, 1],
  ])("matches Python JSON syntax locations for %s", (name, line, column) => {
    const result = checkRecordDocument(
      readFileSync(resolve(data, "invalid", name!)),
      name!,
    );
    expect(result.diagnostics[0]!.location.line).toBe(line);
    expect(result.diagnostics[0]!.location.column).toBe(column);
  });
  it("does not mistake quoted constants or malformed prefixes for nonfinite values", () => {
    expect(loadJson(bytes('{"name":"NaN Infinity -Infinity"}')).value).toEqual({
      name: "NaN Infinity -Infinity",
    });
    for (const text of ["NaN", '{"x": Infinity}', '{"x": -Infinity}']) {
      const result = checkRecordDocument(bytes(text), "record.json");
      expect(result.diagnostics[0]!.location.line).toBeUndefined();
      expect(result.diagnostics[0]!.location.column).toBeUndefined();
    }
    expect(
      checkRecordDocument(bytes("{bad: NaN}"), "record.json").diagnostics[0]!
        .location,
    ).toMatchObject({ line: 1, column: 2 });
    expect(
      checkRecordDocument(bytes("[1,]"), "record.json").diagnostics[0]!
        .location,
    ).toMatchObject({ line: 1, column: 3 });
    expect(
      checkRecordDocument(bytes('"NaN'), "record.json").diagnostics[0]!
        .location,
    ).toMatchObject({ line: 1, column: 1 });
  });
  it("locates schema errors through YAML aliases at the original anchored node", () => {
    const result = loadAnalysisDocument(
      bytes('spec_version: "0.1.0"\nlabel: &value 7\ndescription: *value\n'),
      "astra.yaml",
    );
    expect(
      result.diagnostics
        .map((d) => [d.location.pointer, d.location.line, d.location.column])
        .sort(),
    ).toEqual([
      ["/description", 2, 8],
      ["/label", 2, 8],
    ]);
  });
  it("counts YAML diagnostic columns in Unicode code points", () => {
    const result = loadAnalysisDocument(
      bytes('{spec_version: "0.1.0", label: "😀", outputs: false}'),
      "astra.yaml",
    );
    expect(result.diagnostics[0]).toMatchObject({
      code: "WRONG_TYPE",
      location: { pointer: "/outputs", line: 1, column: 46 },
    });
  });
  it("fills placeholders literally and preserves escaped braces", () =>
    expect(
      fill("{{x}} {inputs} {inputs.data} {decisions.method} {output}", {
        inputs: { data: "some file" },
        decisions: { method: "a" },
        output: "out.json",
      }),
    ).toBe("{x} some file some file a out.json"));
});
