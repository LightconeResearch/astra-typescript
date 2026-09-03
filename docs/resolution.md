# Resolve an ASTRA project

`resolveAnalysis()` validates a complete project, selects one root universe,
and projects authored ASTRA into a recursive data structure for downstream
tools.

```ts
import {
  AnalysisValidationError,
  ProjectLoadError,
  resolveAnalysis,
} from "@astra-spec/sdk";
import { createNodeProjectReader } from "@astra-spec/sdk/node";

const reader = createNodeProjectReader("/path/to/project");

try {
  const bundle = await resolveAnalysis(reader, { universeId: "baseline" });
  render(bundle.document, bundle.bindings);
} catch (error) {
  if (error instanceof AnalysisValidationError) {
    console.error(error.issues);
  } else if (error instanceof ProjectLoadError) {
    console.error(error.code, error.path, error.message);
  }
}
```

An invalid authored project throws `AnalysisValidationError`; its `issues` have
the same contract returned by `validateAnalysis()`. Loading failures and an
explicitly requested universe that does not exist throw `ProjectLoadError`.

## Universe selection

Pass `universeId` when a project has multiple root universes. Without it, the
first universe filename in lexical order is selected implicitly. When no
universe files exist, authored defaults are used and the resolved universe ID
is `default`.

A path-backed sub-analysis is a project of its own, and the same rule applies
to it. A universe node may select one of the sub-analysis's universes by name
(`analyses.<id>.universe: <name>`) or configure it inline with `decisions:` /
`analyses:`. When neither is given — the node is absent or empty, or the root
has no universe files at all — the sub-analysis keeps its own implicit
selection: the first universe filename beside its `astra.yaml` in lexical
order, falling back to its authored defaults under the ancestor's universe ID
when it has none. Its artifacts resolve under that universe, which is where
its own runs wrote them.

The resolved document records the selection and all available root universe
IDs:

```ts
bundle.document.universe;
// {
//   universeId: "baseline",
//   availableUniverseIds: ["baseline", "svm_focused"],
//   source: "explicit"
// }
```

## Bundle shape

```ts
interface ResolvedAnalysisBundle {
  document: ResolvedAnalysisDocument;
  bindings: ArtifactBinding[];
}
```

`document` is JSON-serializable and contains the universe metadata and one
recursive analysis tree. Collections remain ordered arrays. The resolver:

- assigns canonical paths to every analysis and record;
- resolves aliases while retaining the authored `from` value;
- normalizes decision options and effective selections;
- evaluates conditions and exposes `active` on outputs and decisions;
- resolves output provenance, supporting insights, and artifact evidence.

The root analysis path is `$`; child analyses use dotted IDs such as `stage`
and `stage.leaf`. Record paths include their collection, for example
`outputs.figure` and `stage.outputs.plot`.

## Decode a transported bundle

A `ResolvedAnalysisBundle` produced in the same TypeScript process already has
the SDK type. Once a bundle crosses a JSON, structured-clone, storage, message,
or API boundary, treat it as `unknown` and restore that guarantee with the
runtime decoder:

```ts
import {
  parseResolvedAnalysisBundle,
  ResolvedAnalysisBundleValidationError,
} from "@astra-spec/sdk";

const candidate: unknown = JSON.parse(serializedBundle);

try {
  const bundle = parseResolvedAnalysisBundle(candidate);
  render(bundle.document, bundle.bindings);
} catch (error) {
  if (error instanceof ResolvedAnalysisBundleValidationError) {
    for (const issue of error.issues) {
      console.error(`${issue.path}: ${issue.message}`);
    }
  }
}
```

For branch-based control flow, `isResolvedAnalysisBundle(candidate)` provides a
boolean TypeScript type guard instead.

`parseResolvedAnalysisBundle()` validates already-deserialized data; it is not
an alias for `JSON.parse`. It checks the complete known resolved shape and the
current `RESOLVED_ANALYSIS_SCHEMA_VERSION`, returns the original object without
cloning it, and performs no project I/O, reference checking, or semantic
resolution. It rejects non-finite numeric fields and negative artifact byte
sizes so accepted values remain safe to transport. Additional unknown fields
remain intact and do not invalidate the bundle.

## Deterministic artifact paths

Artifact locations are derived directly; the resolver never scans `results/`.

| Output owner | Artifact path |
| --- | --- |
| Root analysis | `results/<universe>/<output>.<format>` |
| Inline descendant | `results/<universe>/<analysis>.<output>.<format>` |
| Deeper inline descendant | Additional analysis IDs joined with dots |
| Path-backed analysis | Its own `results/` directory and a fresh dotted namespace |

A missing artifact is not a validation failure. Inactive outputs, outputs with
no format, and outputs whose known file is absent simply have no artifact
descriptor or binding.

Each materialized output has an `ArtifactBinding`:

```ts
interface ArtifactBinding {
  outputPath: string;
  path: string;
  cacheToken: string;
}
```

`cacheToken` is an opaque equality token for cache-busting artifact reads. It
is SHA-256 over the project-relative path, integer modification time in
milliseconds, and byte size. It is deliberately not a content hash, revision
number, or value that consumers should parse or order.

## Derived views

The resolved document avoids duplicated lookup structures. Derive them only
when a consumer needs them:

```ts
import { collectCitedDois, indexAnalysis, walkAnalyses } from "@astra-spec/sdk";

const index = indexAnalysis(bundle.document);
const figure = index.recordByPath.get("stage.outputs.figure");
const owner = index.analysisByRecordPath.get("stage.outputs.figure"); // the "stage" node

for (const analysis of walkAnalyses(bundle.document)) {
  console.log(analysis.canonicalPath);
}

const citedDois = collectCitedDois(bundle.document);
```
