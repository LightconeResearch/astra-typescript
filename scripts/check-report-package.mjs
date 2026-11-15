// Exercise the published files with the locked dependencies, without network access.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "astra-report-package-"));
const require = createRequire(import.meta.url);

try {
  const packedResult = JSON.parse(execFileSync("npm", [
    "pack", "--ignore-scripts", "--json", "--pack-destination", temporary,
  ], { cwd: root, encoding: "utf8" }));
  const [{ filename }] = Array.isArray(packedResult) ? packedResult : Object.values(packedResult);
  execFileSync("tar", ["-xzf", join(temporary, filename), "-C", temporary]);
  const packed = join(temporary, "package");
  const manifest = JSON.parse(await readFile(join(packed, "package.json"), "utf8"));
  assert.deepEqual(manifest.exports["./reports"], {
    types: "./dist/reports/index.d.ts",
    import: "./dist/reports/index.js",
    default: "./dist/reports/index.js",
  });

  const modules = join(temporary, "node_modules");
  await mkdir(join(modules, "@astra-spec"), { recursive: true });
  await symlink(packed, join(modules, "@astra-spec", "sdk"), "dir");
  for (const dependency of Object.keys(manifest.dependencies)) {
    const destination = join(modules, dependency);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(join(root, "node_modules", dependency), destination, "dir");
  }

  // Follow actual JS imports, including CommonJS imports in AJV, from the new entry point.
  const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
  const visited = new Set();
  const reportDirectory = join(packed, "dist", "reports") + sep;
  async function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    if (file.startsWith(packed + sep)) assert.ok(file.startsWith(reportDirectory), file);
    if (file.endsWith(".json")) return;
    const source = await readFile(file, "utf8");
    for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
      assert.ok(!builtins.has(specifier.replace(/^node:/, "")), `${file}: ${specifier}`);
      assert.ok(!/^yaml(?:\/|$)/.test(specifier), `${file}: ${specifier}`);
      await visit(createRequire(file).resolve(specifier));
    }
  }
  await visit(resolve(packed, manifest.exports["./reports"].import));

  const runtime = join(temporary, "consumer.mjs");
  await writeFile(runtime, `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseResolvedAnalysis } from "@astra-spec/sdk/reports";
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(parseResolvedAnalysis(report), report);
assert.equal(report.schema_version, "astra-tools.resolved-analysis.v1");
`);
  execFileSync(process.execPath, [runtime,
    join(root, "vendor/astra-tools/report-fixtures/driven/resolve.json"),
  ], { stdio: "inherit" });

  await writeFile(join(temporary, "consumer.mts"), `
import {
  parseResolvedAnalysis, parseValidationReport, parseStatusReport,
  type ResolvedAnalysis, type ValidationReport, type StatusReport,
} from "@astra-spec/sdk/reports";
declare const candidate: unknown;
const analysis: ResolvedAnalysis = parseResolvedAnalysis(candidate);
const validation: ValidationReport = parseValidationReport(candidate);
const status: StatusReport = parseStatusReport(candidate);
const version: "astra-tools.resolved-analysis.v1" = analysis.schema_version;
const valid: boolean = validation.valid;
const states: readonly string[] = Object.values(status.statuses).map(value => value.state);
// @ts-expect-error Public report arrays are readonly.
analysis.analyses.push(analysis.analyses[0]!);
// @ts-expect-error Public report fields are readonly.
analysis.spec_version = "changed";
void [version, valid, states];
`);
  await writeFile(join(temporary, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
      lib: ["ES2022", "DOM"], types: [], strict: true, skipLibCheck: false,
      exactOptionalPropertyTypes: true, noEmit: true,
    },
    files: ["consumer.mts"],
  }));
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", temporary], {
    stdio: "inherit",
  });
  console.log(`Report package checks passed (${visited.size} runtime modules inspected).`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
