import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/validation/semantic.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/validation/semantic.js")>();
  return { ...actual, validateAnalysis: () => [] };
});

import { resolveAnalysis } from "../src/index.js";
import { createNodeProjectReader } from "../src/node.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "astra-resolver-defense-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolver defense in depth", () => {
  it("rejects an input alias when nested descent fails partway", async () => {
    await writeFile(
      join(root, "astra.yaml"),
      `version: "0.0.14"
name: Partial descent
inputs: []
outputs:
  - id: result
    type: data
    format: json
analyses:
  existing:
    inputs: []
    outputs: []
  consumer:
    inputs:
      - id: source
        from: ../existing.missing.result
    outputs: []
`,
    );

    await expect(resolveAnalysis(createNodeProjectReader(root))).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_FROM" }),
      ]),
    });
  });
});
