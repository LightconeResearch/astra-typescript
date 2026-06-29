# astra-typescript

TypeScript SDK for the **Agentic Schema for Transparent Research Analysis (ASTRA)** — published as `@astra-spec/sdk`.

Parse, validate, and inspect ASTRA analysis specifications. The package mirrors the validation surface of the Python `astra-tools` SDK and is intended as a foundation for downstream TypeScript tooling (editors, web validators, agent harnesses).

The canonical specification lives at https://astra-spec.org/.

## Install

```bash
npm install @astra-spec/sdk
```

Requires Node ≥18 (uses global `fetch`).

## Schema source

The package does **not** bundle the JSON Schema. It fetches a frozen, versioned copy from astra-spec.org on first use and caches it:

- in memory for the current process
- on disk under `<tmpdir>/astra-schema-cache/<hash>.json` for re-runs

```ts
import { loadAstraSchema, astraSchemaUrl } from "@astra-spec/sdk";

// Defaults to https://astra-spec.org/latest/schema/astra.schema.json
await loadAstraSchema();

// Pin a specific version
await loadAstraSchema({ version: "0.0.10" });
// → https://astra-spec.org/0.0.10/schema/astra.schema.json

// Or supply your own URL (https:// or file://)
await loadAstraSchema({ url: "file:///path/to/astra.schema.json" });

// Or pre-install a schema you already have
import { setAstraSchema } from "@astra-spec/sdk";
setAstraSchema(mySchema, { version: "latest" });
```

Disable disk caching with `cacheDir: false`. Force a refetch with `force: true`.

## Validate an analysis

```ts
import {
  validateAnalysisFile,          // structural (JSON Schema)
  semanticValidateAnalysisFile,  // cross-references, constraints, from-paths
} from "@astra-spec/sdk";

const structural = await validateAnalysisFile("astra.yaml");          // string[]
const semantic = semanticValidateAnalysisFile("astra.yaml");          // SemanticError[]

if (structural.length || semantic.length) {
  for (const e of [...structural, ...semantic]) console.error(String(e));
  process.exit(1);
}
```

Pin to a specific spec version per call:

```ts
await validateAnalysisFile("astra.yaml", { version: "0.0.10" });
```

## Validate a universe

```ts
import {
  validateUniverseFile,   // structural
  validateUniverse,       // semantic, against an analysis
  loadYaml,
} from "@astra-spec/sdk";

const structural = await validateUniverseFile("universes/baseline.yaml");
const semantic = validateUniverse(
  loadYaml("universes/baseline.yaml"),
  loadYaml("astra.yaml"),
);
```

## What ships

| Module | Exports |
|---|---|
| Schema loader | `loadAstraSchema`, `setAstraSchema`, `clearAstraSchemaCache`, `astraSchemaUrl`, `ASTRA_SPEC_HOST`, `JsonSchema`, `SchemaLoadOptions` |
| Structural validation | `validateAnalysisData`, `validateAnalysisFile`, `validateUniverseData`, `validateUniverseFile`, `isValidAnalysis`, `isValidUniverse` (all async) |
| Semantic validation | `validateAnalysis`, `validateUniverse`, `semanticValidateAnalysisFile`, `semanticValidateUniverseFile`, `SemanticError` |
| Helpers | `loadYaml`, `parseYamlString`, `isConditionMet`, `collectNodeDecisions`, `resolveAnalysisTree`, `getInputIds`, `getOutputIds` |
| Types | `Analysis`, `Universe`, `UniverseNode`, `Input`, `Output`, `Decision`, `Option`, `Recipe`, `Resources`, `Insight`, `Evidence`, `TextQuoteSelector`, `FragmentSelector` |

## Validation layers

ASTRA validation is layered, matching the Python implementation:

1. **Structural** — JSON Schema (Ajv, draft 2019-09). Shape, types, required fields, ID patterns, `from`-alias forbidden-field rules. Async because it fetches/loads the schema.
2. **Semantic** — cross-references and constraint resolution: duplicate IDs, default option existence, `from:` direction rules, `Output.inputs` / `Output.decisions` resolution, recipe template placeholders, output dependency cycles, universe selections, constraint compatibility. Synchronous.

## Development

```bash
npm install
npm test          # vitest
npm run build     # tsc → dist/
npm run typecheck
```

The test suite runs offline against a sibling `astra-spec` checkout (expected at `../astra-spec` relative to this repo). It pulls the schema, fixtures, and example projects from there rather than vendoring copies.

## License

BSD-3-Clause. See `LICENSE`.
