# Public API reference

## Node workflows

Import these functions from `@astra-spec/sdk/node`:

| Export | Result |
| --- | --- |
| `validate(path?, options?)` | `Promise<ValidationReport>` |
| `resolve(path?, options?)` | `Promise<ResolvedAnalysis>` |
| `status(path?, options?)` | `Promise<StatusReport>` |
| `readInput(path, inputRef, options?)` | `Promise<Uint8Array \| undefined>` |
| `readResult(path, resultId, options?)` | `Promise<Uint8Array \| undefined>` |

`path` is the analysis folder; the first three functions default to the current
folder. `NodeSourceOptions` has `offline?: boolean` and `cacheDir?: string`.
`readResult` also accepts `placeIndex?: number`, defaulting to zero. A missing
resource, unknown ref/result, unfetched stand-in, or absent place returns
`undefined`. Invalid negative/noninteger place indices throw `RangeError`.

`offline` prevents remote/lazy object fetching. Git authentication follows the
user's Git setup, with interactive password prompting disabled. The remote cache
defaults to astra-tools' platform convention, respects `ASTRA_CACHE_DIR`, and can
be overridden with an absolute `cacheDir`.

Native remote caches support SHA-1 and SHA-256 repositories. An existing cache
with the wrong object format raises `CacheError`; choose a fresh cache directory.
SHA-256 remote support is a deliberate improvement over the pinned Python
reference, which initializes remote caches as SHA-1. The shared JSON model is
unchanged.

`NodeSourceProvider` is exported for integrations that want to open sources
explicitly. Its `worktree(path?)` returns an `AnalysisSource`.

## Host-neutral workflows

The root `@astra-spec/sdk` and `@astra-spec/sdk/resolver` expose:

```ts
validate(source: AnalysisSource): Promise<ValidationReport>
resolve(source: AnalysisSource): Promise<ResolvedAnalysis>
status(source: AnalysisSource): Promise<StatusReport>
readInput(source: AnalysisSource, inputRef: string): Promise<Uint8Array | undefined>
readResult(source: AnalysisSource, resultId: string, placeIndex?: number): Promise<Uint8Array | undefined>
```

An `AnalysisSource` holds `reader`, `folder`, and `provider`. The public source
interfaces are `SourceProvider`, `Tree`, `Repository`, `Entry`, `EntryKind`,
`FollowedFile`, `Digest`, `Declaration`, `DeclarationSource`, and
`DeclarationOutcome`; see [Sources](project-readers.md).

The root also exports `ASTRA_SPEC_VERSION`, the supported authored specification
version, and all [report types, decoders and graph helpers](reports.md).
`@astra-spec/sdk/reports` exposes the report contract alone.

## Errors

| Error | Meaning |
| --- | --- |
| `InvalidAnalysisError` | `resolve`, `status`, or resource access found an invalid analysis; `report` contains validation diagnostics |
| `NoAnalysisError` | The requested folder has no regular `astra.yaml` file |
| `GitError` | Git cannot be invoked or complete a required operation |
| `CacheError` | Cache configuration/storage is unusable |
| `ReportValidationError` | Transported report structure is invalid; `issues` contains JSON Pointer diagnostics |
| `ReportIndexError` | Duplicate analysis keys, element refs or result IDs would make an index ambiguous |

The first four errors are exported by the root and `/node`; report errors and
helpers are exported by the root and `/reports`.

Numeric fields use JavaScript `number`, with its finite precision. Integers
larger than 2^53-1 cannot be represented exactly. This is the normal JSON/number
boundary in TypeScript; the Python model permits arbitrary-size integers.

## Breaking changes from SDK 0.1

The old authored types, `ProjectReader`, `createNodeProjectReader`,
`validateAnalysis`, `resolveAnalysis`, recursive bundle decoder, and artifact
bindings are removed. Use the shared report types and repository-aware APIs.
Universe selection is a lookup over the resolved report; it is no longer a
resolver option. Root analysis identity is `""`, and evidence identity is its
insight ref plus zero-based array index.
