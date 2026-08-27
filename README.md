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

### Deterministic artifact paths

The resolver computes artifact paths directly and never scans result folders:

```text
results/<universe-id>/<output-id>.<format>
results/<universe-id>/<inline-child>.<output-id>.<format>
```

Nested inline analysis ids continue the dotted prefix. A child loaded through
`Analysis.path` starts a new result namespace beside its own `astra.yaml`.
Output aliases bind to their ultimate target file rather than creating a copy.

Each available binding includes an opaque SHA-256 `cacheToken` derived from its
path, modification time, and byte size. Hosts can use it to invalidate stable
serving URLs without reading artifact bytes.

## Other hosts

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

The root entry point is browser-safe and contains no `node:*` imports:

```ts
import {
  parseYamlString,
  validateAnalysisData,
  validateUniverseData,
  validateAnalysis,
  validateUniverse,
} from "@astra-spec/sdk";
```

Filesystem-oriented helpers live under the Node entry point:

```ts
import {
  loadYaml,
  validateAnalysisFile,
  validateUniverseFile,
} from "@astra-spec/sdk/node";
```

Structural validation uses the canonical astra-spec schema bundled with this
SDK, so `resolveAnalysis()` and the validation APIs work offline and do not
follow the moving `latest` schema. `ASTRA_SPEC_VERSION` identifies that bundled
release. The bundled object is immutable. `loadAstraSchema({ version })` and
`loadAstraSchema({ url })` remain available for explicit remote schemas, and
callers can inject a preloaded
schema into `resolveAnalysis(reader, { schema })` or `setAstraSchema()`.

`collectRecommendations()` reports advisory fields such as an omitted output
format. For a multi-file project, pass `bundle.document.analysis` from
`resolveAnalysis()`, which owns recursive loading.

## Optional indexes

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

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

The test suite exercises the bundled canonical schema and does not require a
sibling `astra-spec` checkout or network access.

## License

BSD-3-Clause. See [LICENSE](./LICENSE).
