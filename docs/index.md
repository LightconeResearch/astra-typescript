# ASTRA TypeScript SDK

Validate an entire ASTRA project or open it as one resolved, serializable data
structure. The SDK is host-neutral and works in Node, JupyterLab, editors, and
browser-backed integrations through the same small storage interface.

[Get the package on npm](https://www.npmjs.com/package/@astra-spec/sdk){ .md-button .md-button--primary }
[View the source](https://github.com/LightconeResearch/astra-typescript){ .md-button }

## Install

The SDK requires Node.js 20 or newer.

```bash
npm install @astra-spec/sdk
```

## Two project workflows

| Goal | API | Result |
| --- | --- | --- |
| Check whether a project is valid | [`validateAnalysis()`](validation.md) | `{ valid, issues }` |
| Open a project for a viewer or integration | [`resolveAnalysis()`](resolution.md) | `{ document, bindings }` |

Both functions consume a [`ProjectReader`](project-readers.md). In Node, point
the built-in reader at the **directory containing** `astra.yaml`:

```ts
import { resolveAnalysis } from "@astra-spec/sdk";
import { createNodeProjectReader } from "@astra-spec/sdk/node";

const reader = createNodeProjectReader("/path/to/project");
const bundle = await resolveAnalysis(reader, { universeId: "baseline" });

console.log(bundle.document.analysis);
console.log(bundle.bindings);
```

`resolveAnalysis()` performs complete validation itself. Do not validate first
unless you specifically need the non-throwing validation result.

## Receiving a resolved bundle

If another process or service produced the resolved bundle, validate the
already-deserialized transport value before using it:

```ts
import { parseResolvedAnalysisBundle } from "@astra-spec/sdk";

const candidate: unknown = JSON.parse(serializedBundle);
const bundle = parseResolvedAnalysisBundle(candidate);
```

The decoder returns the same object with the `ResolvedAnalysisBundle` type. It
does not read or resolve a project. See
[Resolve an ASTRA project](resolution.md#decode-a-transported-bundle) for
diagnostics and the non-throwing type guard.

!!! info "Authoring ASTRA"

    This site documents the TypeScript SDK. The canonical schema and authoring
    model live in the [ASTRA specification](https://astra-spec.org/latest/).
