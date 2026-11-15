/** End-to-end native status and resource reads, with real Git records and no recipe execution. */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { readInput, readResult, resolve, status } from "../src/node.js";
import { digestBytes } from "../src/sources/standins.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "astra-native-runtime-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function git(...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Runtime tests",
      "-c",
      "user.email=runtime@astra.invalid",
      "-c",
      "commit.gpgsign=false",
      "-C",
      root,
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
}
const encode = (text: string) => new TextEncoder().encode(text);
const text = (bytes: Uint8Array | undefined) =>
  bytes && new TextDecoder().decode(bytes);
const INPUT = "input\n",
  RESULT = "result\n";
const DOCUMENT = `spec_version: "0.1.0"
inputs:
  raw: {path: data.txt}
outputs:
  result:
    type: data
    format: txt
    inputs: [raw]
    recipe: {command: "cat {inputs.raw} > {output}"}
`;
async function setup(objectFormat?: "sha1" | "sha256"): Promise<string> {
  git(
    "init",
    "--quiet",
    ...(objectFormat ? [`--object-format=${objectFormat}`] : []),
  );
  await writeFile(join(root, "astra.yaml"), DOCUMENT);
  await writeFile(join(root, "data.txt"), INPUT);
  git("add", "--all");
  git("commit", "--quiet", "--message", "source");
  return git("rev-parse", "HEAD");
}
async function record(commit: string): Promise<void> {
  const digest = await digestBytes(encode(RESULT));
  const input = await digestBytes(encode(INPUT));
  const file = join(root, ".astra/records/result.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      address: "result",
      ...digest,
      spec_version: "0.1.0",
      generated_by: {
        commit,
        environment: { iri: "urn:example:test" },
        runner: { id: "native-test", version: "1" },
        inputs: [{ entry: "raw", ...input }],
      },
    }),
  );
  await mkdir(join(root, "results"), { recursive: true });
  await writeFile(join(root, "results/result.txt"), RESULT);
}

describe("native status and resources", () => {
  it("resolves SHA-256 repositories locally and imports their recorded results through a remote cache", async () => {
    const sourceCommit = await setup("sha256");
    expect(sourceCommit).toHaveLength(64);
    await record(sourceCommit);
    git("add", "--all");
    git("commit", "--quiet", "--message", "record");
    const historical = git("rev-parse", "HEAD");
    expect((await resolve(root)).head).toBe(historical);
    expect((await status(root)).statuses.result?.state).toBe("unchanged");
    const driver = join(root, "driver");
    await mkdir(driver);
    await writeFile(
      join(driver, "astra.yaml"),
      `spec_version: "0.1.0"
analyses:
  old: {url: ${JSON.stringify(pathToFileURL(root).href)}, commit: "${historical}"}
outputs:
  summary:
    type: report
    format: txt
    inputs: [old.result]
    recipe: {command: "cat {inputs.old.result} > {output}"}
`,
    );
    const inDriver = (...args: string[]) =>
      execFileSync("git", [
        "-c",
        "user.name=Runtime tests",
        "-c",
        "user.email=runtime@astra.invalid",
        "-c",
        "commit.gpgsign=false",
        "-C",
        driver,
        ...args,
      ]);
    inDriver("init", "--quiet", "--object-format=sha1");
    inDriver("add", "--all");
    inDriver("commit", "--quiet", "--message", "driver");
    const options = { cacheDir: join(root, "remote-cache") };
    const resolved = await resolve(driver, options);
    const imported = resolved.results.find(
      (result) => result.commit?.id === historical,
    )!;
    expect(imported).toBeDefined();
    expect(text(await readResult(driver, imported.id, options))).toBe(RESULT);
    expect(text(await readInput(driver, "old.inputs.raw", options))).toBe(
      INPUT,
    );
    expect((await status(driver, options)).statuses[imported.id]?.state).toBe(
      "unchanged",
    );
  });

  it("checks records independently from byte availability and reads actual input/result bytes", async () => {
    const commit = await setup();
    expect((await status(root)).statuses.result?.state).toBe("missing");
    await record(commit);
    const report = await status(root);
    expect(report.statuses.result).toMatchObject({
      state: "unchanged",
      bytes: { state: "present" },
    });
    expect(text(await readInput(root, "inputs.raw"))).toBe(INPUT);
    expect(text(await readResult(root, "result"))).toBe(RESULT);
    expect(await readResult(root, "unknown")).toBeUndefined();
    await rm(join(root, "results/result.txt"));
    expect((await status(root)).statuses.result).toMatchObject({
      state: "unchanged",
      bytes: { state: "absent" },
    });
    expect(await readResult(root, "result")).toBeUndefined();
  });

  it("detects uncommitted input changes without treating HEAD as a working snapshot", async () => {
    const commit = await setup();
    await record(commit);
    const before = await resolve(root);
    await writeFile(join(root, "data.txt"), "changed\n");
    const after = await status(root);
    expect(after.head).toBe(before.head);
    expect(after.statuses.result?.state).toBe("stale");
  });

  it("uses an unfetched LFS input's content identity and returns no pointer bytes", async () => {
    const commit = await setup();
    await record(commit);
    const input = await digestBytes(encode(INPUT));
    await writeFile(
      join(root, "data.txt"),
      `version https://git-lfs.github.com/spec/v1\noid ${input.content_hash}\nsize ${input.size}\n`,
    );
    const report = await status(root);
    expect(report.inputs["inputs.raw"]).toEqual({
      state: "absent",
      kept_by: "Git LFS",
    });
    expect(report.statuses.result?.state).toBe("unchanged");
    expect(await readInput(root, "inputs.raw")).toBeUndefined();
  });

  it("reads a pinned historical result from its commit rather than the working file", async () => {
    const commit = await setup();
    await record(commit);
    git("add", "--all");
    git("commit", "--quiet", "--message", "record");
    const historical = git("rev-parse", "HEAD");
    await mkdir(join(root, "driver"));
    await writeFile(
      join(root, "driver/astra.yaml"),
      `spec_version: "0.1.0"
analyses:
  old: {path: .., commit: "${historical}"}
outputs:
  summary:
    type: report
    format: txt
    inputs: [old.result]
    recipe: {command: "cat {inputs.old.result} > {output}"}
`,
    );
    git("add", "--all");
    git("commit", "--quiet", "--message", "driver");
    await writeFile(join(root, "results/result.txt"), "current bytes\n");
    const resolved = await resolve(join(root, "driver"));
    const imported = resolved.results.find(
      (result) => result.commit?.id === historical,
    )!;
    expect(imported).toBeDefined();
    expect(text(await readResult(join(root, "driver"), imported.id))).toBe(
      RESULT,
    );
    expect(text(await readInput(join(root, "driver"), "old.inputs.raw"))).toBe(
      INPUT,
    );
  });
});
