/** Records are checked against their generation commit, independently from their bytes. */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolve, status } from "../src/node.js";
import { digestBytes } from "../src/sources/standins.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "astra-record-transitions-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function git(...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Record tests",
      "-c",
      "user.email=records@astra.invalid",
      "-c",
      "commit.gpgsign=false",
      "-C",
      root,
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
}
const content = "same bytes\n";
const DOCUMENT = `spec_version: "0.1.0"
inputs:
  raw: {path: data.txt}
  other: {path: other.txt}
outputs:
  result:
    type: data
    format: txt
    inputs: [raw]
    recipe: {command: "cat {inputs} > {output}"}
`;
async function setup(document = DOCUMENT): Promise<string> {
  git("init", "--quiet");
  await writeFile(join(root, "astra.yaml"), document);
  for (const file of ["data.txt", "other.txt"])
    await writeFile(join(root, file), content);
  git("add", "--all");
  git("commit", "--quiet", "--message", "source");
  return git("rev-parse", "HEAD");
}
async function record(commit: string, id = "result", entry = "raw") {
  const analysis = await resolve(root),
    result = analysis.results.find((r) => r.id === id)!,
    place = result.places[0]!,
    digest = await digestBytes(new TextEncoder().encode(content));
  const value: any = {
    spec_version: "0.1.0",
    address: place.address,
    ...digest,
    generated_by: {
      commit,
      environment: { iri: "urn:example:records" },
      runner: { id: "record-test", version: "1" },
      inputs: [{ entry, ...digest }],
    },
  };
  const path = join(root, place.record_path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
  const output = join(root, place.file_path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, content);
  return { value, path, save: () => writeFile(path, JSON.stringify(value)) };
}
const direct =
  DOCUMENT.replace("    recipe:", "    decisions: [method]\n    recipe:") +
  `decisions:
  method: {options: {a: {}, b: {}}}
universes:
  baseline:
    decisions: {method: a}
`;
const switched =
  DOCUMENT.replace("inputs: [raw]", "inputs: [route]") +
  `  route:
    switch: method
    cases: {a: raw, b: other}
decisions:
  method: {options: {a: {}, b: {}}}
universes:
  baseline:
    decisions: {method: a}
`;

describe("native provenance-record transitions", () => {
  it("rejects a structurally invalid record without inventing JSON schema source positions", async () => {
    const made = await record(await setup());
    delete made.value.size;
    await made.save();
    const report = await status(root);
    expect(report.statuses.result).toMatchObject({
      state: "missing",
      why: [
        {
          code: "INVALID_RECORD",
          location: { file: ".astra/records/result.json", pointer: "" },
        },
      ],
    });
    expect(report.statuses.result!.why[0]!.location.line).toBeUndefined();
  });
  it("rejects a record at another result's address", async () => {
    const made = await record(await setup());
    made.value.address = "someone_else";
    await made.save();
    const checked = (await status(root)).statuses.result!;
    expect(checked.state).toBe("missing");
    expect(checked.why.some((d) => d.code === "MISPLACED_RECORD")).toBe(true);
  });
  it("rejects duplicate JSON object names even when their values agree", async () => {
    const made = await record(await setup());
    const text = await readFile(made.path, "utf8");
    await writeFile(
      made.path,
      text.replace(
        '"address":"result"',
        '"address":"result","address":"result"',
      ),
    );
    const checked = (await status(root)).statuses.result!;
    expect(checked.state).toBe("missing");
    expect(checked.why[0]!.code).toBe("INVALID_RECORD");
    expect(checked.why[0]!.location.line).toBeUndefined();
  });
  it("retains line and column for JSON syntax errors", async () => {
    const made = await record(await setup());
    await writeFile(made.path, "{\n");
    const broken = (await status(root)).statuses.result!.why[0]!;
    expect(broken.code).toBe("INVALID_RECORD");
    expect(broken.location.line).toBeTypeOf("number");
    expect(broken.location.column).toBeTypeOf("number");
  });
  it("rejects records from before ASTRA0.1", async () => {
    const made = await record(await setup());
    made.value.spec_version = "0.0.14";
    await made.save();
    expect((await status(root)).statuses.result).toMatchObject({
      state: "missing",
      why: [{ code: "INVALID_RECORD", location: { pointer: "/spec_version" } }],
    });
  });
  it("accepts later-minor records with additional fields through the open schema", async () => {
    const made = await record(await setup());
    made.value.spec_version = "0.2.0";
    made.value.future = { field: true };
    made.value.generated_by.future = "extension";
    await made.save();
    expect((await status(root)).statuses.result).toMatchObject({
      state: "unchanged",
      record: { spec_version: "0.2.0" },
    });
  });
  it.each(["missing", "extra", "duplicate"])(
    "requires one generation item per declared input: %s",
    async (kind) => {
      const made = await record(await setup());
      if (kind === "missing") made.value.generated_by.inputs = [];
      else
        made.value.generated_by.inputs.push({
          ...made.value.generated_by.inputs[0],
          entry: kind === "extra" ? "unlisted" : "raw",
        });
      await made.save();
      const checked = (await status(root)).statuses.result!;
      expect(checked.state).toBe("missing");
      expect(checked.why.some((d) => d.code === "MISSING_RECORD_INPUTS")).toBe(
        true,
      );
    },
  );
  it("treats labels and descriptions as harmless metadata edits", async () => {
    await record(await setup());
    await writeFile(
      join(root, "astra.yaml"),
      DOCUMENT.replace(
        "    type:",
        "    label: New label\n    description: New prose\n    type:",
      ) + "label: Edited analysis\ndescription: More prose\n",
    );
    expect((await status(root)).statuses.result!.state).toBe("unchanged");
  });
  it("detects a directly used option selection change", async () => {
    await record(await setup(direct), "result#baseline");
    await writeFile(
      join(root, "astra.yaml"),
      direct.replace("decisions: {method: a}", "decisions: {method: b}"),
    );
    const checked = (await status(root)).statuses["result#baseline"]!;
    expect(checked.state).toBe("stale");
    expect(checked.why.some((d) => d.code === "STALE_RESULT")).toBe(true);
  });
  it.each(["selection", "case"])(
    "detects a switch %s change even when both inputs have identical bytes",
    async (change) => {
      await record(await setup(switched), "result#baseline", "route");
      await writeFile(
        join(root, "astra.yaml"),
        change === "selection"
          ? switched.replace("decisions: {method: a}", "decisions: {method: b}")
          : switched.replace(
              "cases: {a: raw, b: other}",
              "cases: {a: other, b: other}",
            ),
      );
      const checked = (await status(root)).statuses["result#baseline"]!;
      expect(checked.state).toBe("stale");
      expect(checked.why.some((d) => d.code === "STALE_RESULT")).toBe(true);
    },
  );
});
