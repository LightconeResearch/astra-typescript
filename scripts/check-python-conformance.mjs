// Explicit development/CI parity check. No Python is used by the SDK itself.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as native from "../dist/node.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length > 1)
  throw new Error(
    "Usage: node scripts/check-python-conformance.mjs [python-executable]",
  );
const python = args[0] ?? process.env.ASTRA_PYTHON ?? "python3";
const cases = join(root, "upstream/astra-spec/conformance/analyses");
const fixtureRoot = join(root, "upstream/astra-tools/tests/report-fixtures");
const manifest = JSON.parse(
  await readFile(join(fixtureRoot, "manifest.json"), "utf8"),
);
const normalize = (value) =>
  Array.isArray(value)
    ? value.map(normalize)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(
              ([key]) =>
                !(
                  key === "message" &&
                  typeof value.code === "string" &&
                  ["error", "warning", "note"].includes(value.level) &&
                  value.location
                ),
            )
            .map(([key, item]) => [key, normalize(item)]),
        )
      : value;
// Diagnostic order and human wording are implementation details; rule locations are not.
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const normalizedValidation = (report) => {
  const diagnostics = report.diagnostics.map((item) => ({
    code: item.code,
    level: item.level,
    location: canonical(item.location),
    related: item.related
      .map(canonical)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  }));
  return {
    ...report,
    unchecked: [...report.unchecked].sort(),
    diagnostics: [
      ...new Map(
        diagnostics.map((item) => [JSON.stringify(item), item]),
      ).values(),
    ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
};
let compared = 0,
  invalid = 0;
const failures = [];
async function checkCase(
  name,
  folder,
  extra = {},
  files = join(folder, "files"),
) {
  const place = await mkdtemp(join(tmpdir(), "astra-python-parity-")),
    work = join(place, "work");
  try {
    await Promise.all([
      mkdir(join(place, "home")),
      mkdir(join(place, "remotes")),
    ]);
    await cp(files, work, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const env = {
      PATH: process.env.PATH,
      HOME: join(place, "home"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "ASTRA conformance",
      GIT_COMMITTER_NAME: "ASTRA conformance",
      GIT_AUTHOR_EMAIL: "conformance@astra.invalid",
      GIT_COMMITTER_EMAIL: "conformance@astra.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      GIT_CEILING_DIRECTORIES: place,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "protocol.file.allow",
      GIT_CONFIG_VALUE_0: "always",
      ASTRA_CASE_REMOTES: join(place, "remotes"),
      ...extra,
    };
    const setup = join(folder, "setup.sh");
    if (existsSync(setup))
      execFileSync("sh", ["-eu", setup], { cwd: work, env, stdio: "pipe" });
    else
      for (const options of [
        ["init"],
        ["add", "--all"],
        ["commit", "--message", "files"],
      ])
        execFileSync("git", options, { cwd: work, env, stdio: "pipe" });
    const expected = existsSync(join(folder, "expected.json"))
      ? JSON.parse(await readFile(join(folder, "expected.json"), "utf8"))
      : {};
    const target = join(work, expected.root ?? ".");
    const oracle = JSON.parse(
      execFileSync(python, [join(root, "scripts/python-oracle.py"), target], {
        encoding: "utf8",
        env: {
          ...process.env,
          ...env,
          ASTRA_CACHE_DIR: join(place, "python-cache"),
        },
        maxBuffer: 32 * 1024 * 1024,
      }),
    );
    const options = { cacheDir: join(place, "typescript-cache") };
    const validation = await native.validate(target, options);
    assert.deepStrictEqual(
      normalizedValidation(validation),
      normalizedValidation(oracle.validate),
      `${name}: validation diagnostics differ`,
    );
    if (!oracle.validate.valid) {
      invalid++;
      return;
    }
    for (const operation of ["resolve", "status"]) {
      const actual = await native[operation](target, options);
      assert.deepStrictEqual(
        normalize(actual),
        normalize(oracle[operation]),
        `${name}: ${operation} differs`,
      );
    }
    compared++;
  } catch (error) {
    failures.push(name);
    console.error(`${name}: ${error.stack ?? error}`);
  } finally {
    await rm(place, { recursive: true, force: true });
  }
}
for (const name of (await readdir(cases))
  .filter((name) => /^\d/.test(name))
  .sort())
  await checkCase(name, join(cases, name));
for (const name of manifest.cases)
  await checkCase(
    `report-${name}`,
    join(fixtureRoot, name),
    manifest.git_environment,
  );
for (const name of ["iris", "iris_pipeline"]) {
  const folder = join(root, "upstream/astra-spec/examples", name);
  await checkCase(`example-${name}`, folder, {}, folder);
}
console.log(
  `Python parity: ${compared} valid cases (resolve and status), ${invalid} invalid validation reports, ${failures.length} failures.`,
);
if (failures.length) {
  console.error(`Failed cases: ${failures.join(", ")}`);
  process.exitCode = 1;
}
