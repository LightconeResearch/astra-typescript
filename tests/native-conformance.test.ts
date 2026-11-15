import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validate, resolve as resolveAnalysis, status } from "../src/node.js";
import { buildCase } from "./native-case.js";

const cases = resolve("upstream/astra-spec/conformance/analyses");
const names = readdirSync(cases)
  .filter((name) => /^\d/.test(name))
  .sort();

describe("ASTRA 0.1 analysis conformance", () => {
  it.each(names)(
    "%s",
    async (name) => {
      const path = join(cases, name);
      const expected = JSON.parse(
        readFileSync(join(path, "expected.json"), "utf8"),
      );
      const built = await buildCase(path);
      try {
        const report = await validate(join(built.work, expected.root ?? "."), {
          cacheDir: join(built.place, "cache"),
        });
        expect(report.valid, JSON.stringify(report.diagnostics, null, 2)).toBe(
          expected.valid,
        );
        for (const required of expected.must_report ?? []) {
          expect(
            report.diagnostics.some(
              (d) =>
                d.code === required.code &&
                (required.file === undefined ||
                  d.location.file === required.file) &&
                (required.pointer === undefined ||
                  d.location.pointer === required.pointer),
            ),
            JSON.stringify(
              { required, diagnostics: report.diagnostics },
              null,
              2,
            ),
          ).toBe(true);
        }
        for (const forbidden of expected.must_not_report ?? []) {
          expect(report.diagnostics.some((d) => d.code === forbidden)).toBe(
            false,
          );
        }
      } finally {
        await built.dispose();
      }
    },
    30_000,
  );
});

const fixtures = resolve("upstream/astra-tools/tests/report-fixtures");
const manifest = JSON.parse(
  readFileSync(join(fixtures, "manifest.json"), "utf8"),
);
describe("Python public-report golden parity", () => {
  it.each(manifest.cases as string[])(
    "%s",
    async (name) => {
      const path = join(fixtures, name);
      const built = await buildCase(path, manifest.git_environment);
      try {
        const options = { offline: true, cacheDir: join(built.place, "cache") };
        for (const [operation, run] of [
          ["validate", validate],
          ["resolve", resolveAnalysis],
          ["status", status],
        ] as const) {
          const actual = await run(built.work, options);
          const expected = JSON.parse(
            readFileSync(join(path, `${operation}.json`), "utf8"),
          );
          expect(actual).toEqual(expected);
        }
      } finally {
        await built.dispose();
      }
    },
    30_000,
  );
});
