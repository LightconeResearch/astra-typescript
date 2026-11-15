import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const UPSTREAM = resolve(ROOT, "upstream/astra-tools");
const SCRIPT = "scripts/generate-report-contract.mjs";

describe("pinned report contract", () => {
  it("checks generated TypeScript against the initialized submodule", () => {
    expect(() => execFileSync(process.execPath, [SCRIPT, "--check"], {
      cwd: ROOT,
      stdio: "pipe",
    })).not.toThrow();
  });

  it("pins both the checked-out contract and the original golden-report oracle", () => {
    const stage = execFileSync("git", ["ls-files", "--stage", "--", "upstream/astra-tools"], {
      cwd: ROOT, encoding: "utf8",
    });
    const [, pin] = /^160000 ([0-9a-f]{40}) 0\tupstream\/astra-tools\n$/.exec(stage)!;
    const revision = execFileSync("git", ["-C", UPSTREAM, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(pin).toBe(revision);
    const fixtures = JSON.parse(readFileSync(resolve(UPSTREAM, "tests/report-fixtures/manifest.json"), "utf8"));
    expect(fixtures.oracle.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(fixtures.specification.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("explains how to initialize a missing submodule", () => {
    const place = mkdtempSync(resolve(tmpdir(), "astra-report-uninitialized-"));
    try {
      mkdirSync(resolve(place, "scripts"));
      copyFileSync(resolve(ROOT, SCRIPT), resolve(place, SCRIPT));
      expect(() => execFileSync(process.execPath, [SCRIPT, "--check"], {
        cwd: place, stdio: "pipe",
      })).toThrow("git submodule update --init upstream/astra-tools");
    } finally {
      rmSync(place, { recursive: true, force: true });
    }
  });
});
