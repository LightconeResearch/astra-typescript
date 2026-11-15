import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");

describe("pinned report contract", () => {
  it("verifies artifact hashes and generated TypeScript without Python, Git, or network access", () => {
    expect(() => execFileSync(process.execPath, ["scripts/generate-report-contract.mjs", "--check"], {
      cwd: ROOT,
      env: { ...process.env, PATH: "" },
      stdio: "pipe",
    })).not.toThrow();
  });

  it("pins both the imported contract and the original golden-report oracle", () => {
    const source = JSON.parse(readFileSync(resolve(ROOT, "vendor/astra-tools/source.json"), "utf8"));
    const fixtures = JSON.parse(readFileSync(resolve(ROOT, "vendor/astra-tools/report-fixtures/manifest.json"), "utf8"));
    expect(source.repository).toBe("https://github.com/astra-project/astra-tools");
    expect(source.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(fixtures.oracle.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(fixtures.specification.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(source.files)).toContain("reports.schema.json");
    for (const name of fixtures.cases) {
      for (const operation of ["validate", "resolve", "status"]) {
        expect(Object.keys(source.files)).toContain(`report-fixtures/${name}/${operation}.json`);
      }
    }
  });
});
