// Exercise the published files with locked dependencies and no Python/runtime checkout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "astra-package-"));
const require = createRequire(import.meta.url);

try {
  const packedResult = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
      { cwd: root, encoding: "utf8" },
    ),
  );
  const [packageInfo] = Array.isArray(packedResult)
    ? packedResult
    : Object.values(packedResult);
  for (const { path } of packageInfo.files) {
    assert.ok(
      path.startsWith("dist/") ||
        ["LICENSE", "README.md", "package.json"].includes(path),
      `Unexpected published file: ${path}`,
    );
  }
  execFileSync("tar", [
    "-xzf",
    join(temporary, packageInfo.filename),
    "-C",
    temporary,
  ]);
  const packed = join(temporary, "package");
  const manifest = JSON.parse(
    await readFile(join(packed, "package.json"), "utf8"),
  );
  for (const [entry, file] of [
    [".", "index"],
    ["./reports", "reports/index"],
    ["./resolver", "resolver"],
    ["./node", "node"],
  ]) {
    assert.deepEqual(manifest.exports[entry], {
      types: `./dist/${file}.d.ts`,
      import: `./dist/${file}.js`,
      default: `./dist/${file}.js`,
    });
  }
  const modules = join(temporary, "node_modules");
  await mkdir(join(modules, "@astra-spec"), { recursive: true });
  await symlink(packed, join(modules, "@astra-spec", "sdk"), "dir");
  for (const dependency of Object.keys(manifest.dependencies)) {
    const destination = join(modules, dependency);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(join(root, "node_modules", dependency), destination, "dir");
  }

  const builtins = new Set(
    builtinModules.map((name) => name.replace(/^node:/, "")),
  );
  async function inspect(entry, reportsOnly = false) {
    const visited = new Set();
    async function visit(file) {
      if (visited.has(file)) return;
      visited.add(file);
      if (reportsOnly && file.startsWith(packed + sep)) {
        assert.ok(file.startsWith(join(packed, "dist", "reports") + sep), file);
      }
      if (file.endsWith(".json")) return;
      for (const { fileName: specifier } of ts.preProcessFile(
        await readFile(file, "utf8"),
        true,
        true,
      ).importedFiles) {
        assert.ok(
          !builtins.has(specifier.replace(/^node:/, "")),
          `${file}: ${specifier}`,
        );
        if (reportsOnly)
          assert.ok(!/^yaml(?:\/|$)/.test(specifier), `${file}: ${specifier}`);
        let dependency = createRequire(file).resolve(specifier);
        // YAML publishes distinct Node and browser builds via conditional exports.
        if (specifier === "yaml") {
          const packageFile = createRequire(file).resolve("yaml/package.json");
          const yaml = JSON.parse(await readFile(packageFile, "utf8"));
          assert.equal(typeof yaml.exports["."].default, "string");
          dependency = resolve(dirname(packageFile), yaml.exports["."].default);
        }
        await visit(dependency);
      }
    }
    await visit(resolve(packed, manifest.exports[entry].import));
    return visited.size;
  }
  const reportModules = await inspect("./reports", true);
  const rootModules = await inspect(".");
  await inspect("./resolver");

  const fixture = join(temporary, "resolve.json");
  await writeFile(
    fixture,
    await readFile(
      join(
        root,
        "upstream/astra-tools/tests/report-fixtures/driven/resolve.json",
      ),
    ),
  );
  const reportsRuntime = join(temporary, "reports.mjs");
  await writeFile(
    reportsRuntime,
    `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseResolvedAnalysis, indexResolvedAnalysis, getResultOwner, selectResult, walkResultDependencies } from "@astra-spec/sdk/reports";
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(parseResolvedAnalysis(report), report);
const index = indexResolvedAnalysis(report);
assert.equal(getResultOwner(index, "stage.fit#baseline").key, "");
assert.equal(getResultOwner(index, "stage:fit#local").key, "stage");
assert.equal(selectResult(index, "outputs.shared", "universes.alternate").id, "shared");
assert.deepEqual([...walkResultDependencies(index, "comparison#alternate")].map(value => value.id),
  ["shared", "stage.fit#alternate", "stage:fit#local"]);
`,
  );
  execFileSync(process.execPath, [reportsRuntime, fixture], {
    cwd: temporary,
    env: { ...process.env, PATH: "" },
    stdio: "inherit",
  });

  // The native SDK may execute Git, but no Python/uv or checkout-provided executable.
  let gitExecutable;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(
      directory,
      process.platform === "win32" ? "git.exe" : "git",
    );
    try {
      await access(candidate, constants.X_OK);
      gitExecutable = candidate;
      break;
    } catch {}
  }
  assert.ok(gitExecutable, "Package smoke tests need Git");
  const binaries = join(temporary, "bin");
  await mkdir(binaries);
  await symlink(
    resolve(gitExecutable),
    join(binaries, process.platform === "win32" ? "git.exe" : "git"),
  );
  const project = join(temporary, "analysis");
  await mkdir(project);
  await writeFile(
    join(project, "astra.yaml"),
    `spec_version: "0.1.0"
inputs:
  raw: {path: data.txt}
outputs:
  result:
    type: data
    format: txt
    recipe: {command: "printf result > {output}"}
`,
  );
  await writeFile(join(project, "data.txt"), "input\n");
  const environment = {
    ...process.env,
    PATH: binaries,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (...args) =>
    execFileSync(gitExecutable, ["-C", project, ...args], {
      env: environment,
      encoding: "utf8",
    }).trim();
  git("init", "--quiet");
  git("add", "--all");
  git(
    "-c",
    "user.name=Package tests",
    "-c",
    "user.email=package@astra.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--message",
    "source",
  );
  const nativeRuntime = join(temporary, "native.mjs");
  await writeFile(
    nativeRuntime,
    `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as sdk from "@astra-spec/sdk";
import * as resolver from "@astra-spec/sdk/resolver";
import * as native from "@astra-spec/sdk/node";
const project = process.argv[2]; const options = { offline: true, cacheDir: join(project, "cache") };
assert.equal(sdk.ASTRA_SPEC_VERSION, "0.1.0");
assert.equal("validateAnalysis" in sdk, false);
assert.equal("createNodeProjectReader" in native, false);
assert.equal((await native.validate(project, options)).valid, true);
const report = await native.resolve(project, options);
assert.equal(report.results[0].id, "result");
assert.equal((await native.status(project, options)).statuses.result.state, "missing");
await mkdir(join(project, "results")); await mkdir(join(project, ".astra/records"), { recursive: true });
const bytes = "result\\n";
await writeFile(join(project, "results/result.txt"), bytes);
await writeFile(join(project, ".astra/records/result.json"), JSON.stringify({
  address: "result", content_hash: "sha256:" + createHash("sha256").update(bytes).digest("hex"), size: Buffer.byteLength(bytes), spec_version: "0.1.0",
  generated_by: { commit: report.head, environment: { iri: "urn:example:package" }, runner: { id: "package-test", version: "1" } },
}));
assert.deepEqual((await native.status(project, options)).statuses.result.bytes, { state: "present" });
assert.equal((await native.status(project, options)).statuses.result.state, "unchanged");
assert.equal(new TextDecoder().decode(await native.readResult(project, "result", options)), bytes);
assert.equal(new TextDecoder().decode(await native.readInput(project, "inputs.raw", options)), "input\\n");
const provider = new native.NodeSourceProvider(options); const source = await provider.worktree(project);
assert.deepEqual(await sdk.resolve(source), await resolver.resolve(source));
assert.equal((await sdk.validate(source)).valid, true);
assert.equal((await resolver.status(source)).statuses.result.state, "unchanged");
`,
  );
  execFileSync(process.execPath, [nativeRuntime, project], {
    cwd: temporary,
    env: environment,
    stdio: "inherit",
  });

  await writeFile(
    join(temporary, "consumer.mts"),
    `
import { parseResolvedAnalysis, parseStatusReport, indexResolvedAnalysis, selectResult, type ResolvedAnalysis } from "@astra-spec/sdk/reports";
import { resolve, validate, status, readInput, readResult, ASTRA_SPEC_VERSION } from "@astra-spec/sdk";
import { resolve as resolveFromProvider, type AnalysisSource } from "@astra-spec/sdk/resolver";
declare const candidate: unknown; declare const source: AnalysisSource;
const analysis: ResolvedAnalysis = parseResolvedAnalysis(candidate);
const index = indexResolvedAnalysis(analysis);
const version: "astra-tools.resolved-analysis.v1" = analysis.schema_version;
const state: string | undefined = parseStatusReport(candidate).statuses.result?.state;
const opened: Promise<ResolvedAnalysis> = resolve(source);
const providerOpened: Promise<ResolvedAnalysis> = resolveFromProvider(source);
void [version, state, opened, providerOpened, validate(source), status(source), readInput(source, "inputs.raw"), readResult(source, "result"), ASTRA_SPEC_VERSION, selectResult(index, "outputs.fit", "universes.baseline")];
// @ts-expect-error Public report arrays are readonly.
analysis.analyses.push(analysis.analyses[0]!);
// @ts-expect-error Derived maps are readonly.
index.analysisByKey.set("other", analysis.analyses[0]!);
`,
  );
  await writeFile(
    join(temporary, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022", "DOM"],
        types: [],
        strict: true,
        skipLibCheck: false,
        exactOptionalPropertyTypes: true,
        noEmit: true,
      },
      files: ["consumer.mts"],
    }),
  );
  execFileSync(
    process.execPath,
    [require.resolve("typescript/bin/tsc"), "-p", temporary],
    { stdio: "inherit" },
  );
  console.log(
    `Package checks passed (reports: ${reportModules}, root: ${rootModules} runtime modules; native Git-only smoke).`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
