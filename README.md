# astra-typescript

TypeScript SDK for the **Agentic Schema for Transparent Research Analysis
(ASTRA)**, published as `@astra-spec/sdk`.

The SDK parses and validates authored ASTRA data and resolves a complete project
into one recursive, serializable document for viewers and integrations. The
canonical specification lives at <https://astra-spec.org/>.

## Install

```bash
npm install @astra-spec/sdk
```

## Resolve a project

The resolver depends on the small, read-only `ProjectReader` interface, so the
same operation works with Node, JupyterLab, VS Code, or browser-local storage.
Node projects can use the bundled adapter:

```ts
import { resolveAnalysis } from "@astra-spec/sdk";
import { createNodeProjectReader } from "@astra-spec/sdk/node";

const reader = createNodeProjectReader("/path/to/project");
const bundle = await resolveAnalysis(reader, { universeId: "baseline" });

console.log(bundle.document.analysis.outputs);
console.log(bundle.bindings);
```

`bundle.document` is host-neutral JSON data. It recursively retains the ASTRA
analysis tree and includes resolved aliases, conditions, decision selections,
provenance, evidence links, and artifact metadata. `bundle.bindings` stays on
the host side and maps materialized outputs to project-relative files.

Invalid projects reject with `AnalysisValidationError`; loading and storage
failures reject with `ResolveAnalysisError`. A missing output artifact is not an
error: the output simply has no `artifact` descriptor or binding.

### Optional indexes

The resolved bundle contains no lookup maps. Build them only when needed:

```ts
import { indexAnalysis } from "@astra-spec/sdk";

const index = indexAnalysis(bundle.document);
const output = index.recordByPath.get("stage.outputs.figure");
```

Normalized cited DOI lists are also derived rather than duplicated in the
resolved bundle:

```ts
import { collectCitedDois } from "@astra-spec/sdk";

const citedDois = collectCitedDois(bundle.document);
```

### Other hosts

An integration implements this contract around its native storage API:

```ts
interface ProjectReader {
  readText(path: string): Promise<string>;
  stat(path: string): Promise<ProjectEntry | undefined>;
  readDirectory(path: string): Promise<ProjectDirectoryEntry[]>;
}
```

All paths passed by the resolver are normalized POSIX paths relative to the
chosen project root. `stat()` reports file size and integer Unix modification
time in milliseconds. The exported `ProjectReader`, `ProjectEntry`, and
`ProjectDirectoryEntry` types are the adapter contract.

## Validation and parsing

Parsing and validation are separate. `parseYamlString()` is browser-safe;
`loadYaml()` reads a file in Node. Both return plain data and throw when the
YAML cannot be parsed, but neither checks that the data is a valid ASTRA
document.

### Validate an analysis file

For a standalone `astra.yaml`, first check its structure against the bundled
schema, then run the semantic checks:

```ts
import {
  validateAnalysisData,
  validateAnalysis,
} from "@astra-spec/sdk";
import { loadYaml } from "@astra-spec/sdk/node";

const analysis = loadYaml("astra.yaml");
const errors = await validateAnalysisData(analysis);

// Semantic validation expects structurally valid data.
if (errors.length === 0) {
  errors.push(...validateAnalysis(analysis).map((error) => error.toString()));
}

if (errors.length > 0) {
  throw new Error(`Invalid astra.yaml:\n${errors.join("\n")}`);
}
```

`validateAnalysisData()` checks schema structure; `validateAnalysis()` checks
references, dependencies, decision constraints, and other semantic rules. If
only the structural check is needed, the Node shortcut is:

```ts
import { validateAnalysisFile } from "@astra-spec/sdk/node";

const schemaErrors = await validateAnalysisFile("astra.yaml");
```

For universes, use `validateUniverseData()` or `validateUniverseFile()` for
structure and `validateUniverse(universe, analysis)` for semantics. The root
entry point remains browser-safe and contains no `node:*` imports.

These functions validate one authored document. For a complete project with
path-backed analyses and universe files, use `resolveAnalysis()`: it owns
recursive loading and rejects the complete issue set as an
`AnalysisValidationError`.

Structural validation uses the exact canonical astra-spec schema bundled with
the SDK, so it works offline and never follows the moving `latest` schema.
`ASTRA_SPEC_VERSION` identifies the bundled release. Explicit schema overrides
remain available through `loadAstraSchema({ version })`,
`loadAstraSchema({ url })`, `setAstraSchema()`, or the
`resolveAnalysis(reader, { schema })` option.

`collectRecommendations()` reports advisory fields such as an omitted output
`resolveAnalysis()`.

## License

BSD-3-Clause. See [LICENSE](./LICENSE).
