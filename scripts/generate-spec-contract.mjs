// Bundle the pinned ASTRA schemas and rule catalogue for the native engine.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = resolve(root, "upstream/astra-spec");
if (!existsSync(resolve(upstream, "project/rules/rules.json"))) {
  throw new Error(
    "Initialize the specification: git submodule update --init upstream/astra-spec",
  );
}
const revision = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
execFileSync("git", [
  "-C",
  upstream,
  "diff",
  "--quiet",
  "HEAD",
  "--",
  "project/jsonschema",
  "project/rules",
]);
const names = {
  analysisSchema: "jsonschema/analysis.schema.json",
  provenanceSchema: "jsonschema/provenance.schema.json",
  openProvenanceSchema: "jsonschema/provenance.open.schema.json",
  ruleCatalogue: "rules/rules.json",
};
let content = `// Generated from astra-spec ${revision}; do not edit.\n`;
content += `export const ASTRA_SPEC_VERSION = "0.1.0" as const;\n`;
for (const [name, path] of Object.entries(names)) {
  const data = JSON.parse(
    readFileSync(resolve(upstream, "project", path), "utf8"),
  );
  content += `export const ${name}: Record<string, any> = ${JSON.stringify(data)};\n`;
}
const destination = resolve(root, "src/engine/spec.ts");
if (process.argv.includes("--check")) {
  if (readFileSync(destination, "utf8") !== content)
    throw new Error(
      "Specification bundle is stale; run scripts/generate-spec-contract.mjs",
    );
} else {
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}
