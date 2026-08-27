# astra-typescript

TypeScript SDK for the **Agentic Schema for Transparent Research Analysis
(ASTRA)**, published as `@astra-spec/sdk`.

The SDK has two project workflows:

- `validateAnalysis()` answers whether an authored ASTRA project is valid and
  returns structured issues.
- `resolveAnalysis()` validates the project and opens it as one recursive,
  serializable data structure for viewers and integrations.

The canonical specification lives at <https://astra-spec.org/>.

## Install

```bash
npm install @astra-spec/sdk
```

Both workflows read through the small, host-neutral `ProjectReader` interface.
For Node, create a reader rooted at the directory containing `astra.yaml`:

```ts
import { createNodeProjectReader } from "@astra-spec/sdk/node";

const reader = createNodeProjectReader("/path/to/project");
```

## Validate a project

`validateAnalysis()` recursively checks the root `astra.yaml`, path-backed
analyses, and universe files. It applies the bundled structural schema and the
project-level semantic and reference checks in one operation. Every universe
file is parsed and reference-checked; configuration-dependent conditions and
constraints are evaluated from each root universe through the named child
universes it selects.

```ts
import { validateAnalysis } from "@astra-spec/sdk";
import { createNodeProjectReader } from "@astra-spec/sdk/node";

const reader = createNodeProjectReader("/path/to/project");
const result = await validateAnalysis(reader);

if (!result.valid) {
  for (const issue of result.issues) {
    const location = [issue.file, issue.path].filter(Boolean).join(":");
    console.error(`${location}: ${issue.message}`);
  }
}
```

Each issue has a stable `code`, a human-readable `message`, the
project-relative `file`, and, when available, the authored field `path`.
Malformed YAML and other authored project problems return
`{ valid: false, issues }`. Reader failures and backend-enforced project-root
escapes throw a `ProjectLoadError` because the project could not be read safely;
a lexical escape written in `Analysis.path` is an authored validation issue.

## Resolve a project

`resolveAnalysis()` runs the same complete validation internally, then resolves
aliases, conditions, decision selections, provenance, evidence links, and
artifact bindings for one universe. There is no need to call
`validateAnalysis()` first unless the caller specifically wants a validation
result instead of an exception.

```ts
import { resolveAnalysis } from "@astra-spec/sdk";
import { createNodeProjectReader } from "@astra-spec/sdk/node";

const reader = createNodeProjectReader("/path/to/project");
const bundle = await resolveAnalysis(reader, { universeId: "baseline" });

console.log(bundle.document.analysis.outputs);
console.log(bundle.bindings);
```

`bundle.document` is host-neutral JSON data containing the recursive resolved
analysis tree. `bundle.bindings` maps materialized output canonical paths to
project-relative artifact files and opaque cache tokens. A missing output
artifact is not a project error: the output simply has no artifact descriptor
or binding.

### Deterministic artifact paths

Output locations are derived without scanning `results/`. A root output lives
at `results/<universe>/<output>.<format>`; an inline nested output lives at
`results/<universe>/<analysis>.<output>.<format>` (with additional analysis IDs
joined by dots). A path-backed analysis owns its own `results/` directory and
starts a fresh artifact namespace.

The resolver stats only these known paths. A binding is present when the file
exists and carries an opaque cache token for downstream cache busting.
The token is SHA-256 over the project-relative path, integer modification time
in milliseconds, and byte size. It is a cheap equality token, not an artifact
content hash; consumers must not parse or order it.

Invalid projects reject with `AnalysisValidationError`, whose `issues` use the
same shape returned by `validateAnalysis()`. Loading and storage failures reject
with `ProjectLoadError`; so does an explicitly requested root universe that does
not exist.

### Derived lookups

The resolved document contains no lookup maps. Build them only when needed:

```ts
import { indexAnalysis } from "@astra-spec/sdk";

const index = indexAnalysis(bundle.document);
const output = index.recordByPath.get("stage.outputs.figure");
```

Normalized cited DOI lists are also derived rather than duplicated:

```ts
import { collectCitedDois } from "@astra-spec/sdk";

const citedDois = collectCitedDois(bundle.document);
```

## Other hosts

JupyterLab, editors, and browser-local integrations can implement the same
read-only storage contract:

```ts
interface ProjectReader {
  readText(path: string): Promise<string>;
  stat(path: string): Promise<ProjectEntry | undefined>;
  readDirectory(path: string): Promise<ProjectDirectoryEntry[]>;
}
```

The contract is:

- Paths are normalized POSIX paths relative to the chosen project root; `""`
  denotes the root. An adapter must prevent backend-specific escapes, such as
  symbolic links, by throwing `ProjectPathError`.
- `readText()` returns UTF-8 text for an existing file and rejects missing
  paths, directories, decoding errors, and backend failures.
- `stat()` returns `undefined` only for a missing path. A file entry contains a
  non-negative safe-integer byte size and Unix modification time in
  milliseconds; a directory entry needs only its type.
- `readDirectory()` returns immediate children with bare names and rejects a
  missing path, a non-directory, or a backend failure. Child order is not
  significant.

The SDK validates adapter responses. Invalid responses and ordinary backend
failures become `ProjectLoadError` with `READ_FAILED`; `ProjectPathError`
becomes `PROJECT_PATH_ESCAPE`. The package exports `ProjectReader`,
`ProjectEntry`, and `ProjectDirectoryEntry` for adapter implementations.

`ASTRA_SPEC_VERSION` identifies the canonical schema bundled with this SDK.

## License

BSD-3-Clause. See [LICENSE](./LICENSE).
