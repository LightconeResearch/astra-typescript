# Public API reference

This is the complete export inventory. Everything is imported from
`@astra-spec/sdk` unless a different entry point is shown.

## Project workflows and errors

| Export | Kind | Purpose |
| --- | --- | --- |
| `validateAnalysis` | function | Validate one complete project through a `ProjectReader`. |
| `resolveAnalysis` | function | Validate and resolve one project and selected universe. |
| `ResolveAnalysisOptions` | interface | Options for `resolveAnalysis`; currently contains `universeId`. |
| `AnalysisValidationResult` | interface | The `{ valid, issues }` result returned by validation. |
| `ValidationIssue` | interface | One authored issue with a code, message, file, and optional field path. |
| `AnalysisValidationError` | class | Error thrown by resolution when authored validation fails. |
| `ProjectLoadError` | class | Error for reader, storage, root-boundary, and requested-universe failures. |
| `ProjectLoadErrorCode` | type | Union of the stable `ProjectLoadError.code` values. |

## Project access and path helpers

| Export | Kind | Purpose |
| --- | --- | --- |
| `ProjectReader` | interface | Host-neutral read-only access to one project root. |
| `ProjectEntry` | type | File or directory metadata returned by `ProjectReader.stat`. |
| `ProjectDirectoryEntry` | interface | One immediate child returned by `ProjectReader.readDirectory`. |
| `ProjectPathError` | class | Adapter signal that a backend path escapes the project root. |
| `assertProjectPath` | function | Assert that a path is normalized, POSIX, and project-relative. |
| `joinProjectPath` | function | Join project-relative paths while rejecting lexical root escapes. |
| `projectDirname` | function | Return the parent of a normalized project-relative path. |

The Node adapter is a separate entry point:

| Export | Entry point | Purpose |
| --- | --- | --- |
| `createNodeProjectReader` | `@astra-spec/sdk/node` | Create a filesystem-backed reader rooted at an ASTRA project directory. |

## Version constants

| Export | Kind | Purpose |
| --- | --- | --- |
| `ASTRA_SPEC_VERSION` | constant | Version of the canonical ASTRA schema bundled with the SDK. |
| `RESOLVED_ANALYSIS_SCHEMA_VERSION` | constant | Version identifier for the resolved document contract. |

## Resolved data model

| Export | Kind | Purpose |
| --- | --- | --- |
| `ResolvedAnalysisBundle` | interface | Top-level result containing the document and artifact bindings. |
| `ResolvedAnalysisDocument` | interface | Serializable resolved analysis plus universe metadata. |
| `UniverseSelection` | interface | Effective universe, available universes, and selection source. |
| `ResolvedRootAnalysis` | type | Root analysis with guaranteed `version` and `name`. |
| `ResolvedAnalysisNode` | type | One recursive resolved analysis node. |
| `ResolvedChildAnalysis` | type | A resolved child node with a guaranteed `id`. |
| `ResolvedRecord` | type | Union of resolved inputs, outputs, decisions, and insights. |
| `ResolvedRecordFields` | interface | Fields common to resolved records, currently `canonicalPath`. |
| `ResolvedInput` | type | Input with its effective type and optional alias target. |
| `ResolvedOutput` | type | Output with activity, provenance, alias, and artifact metadata. |
| `ResolvedDecision` | type | Decision with normalized options, activity, and effective selection. |
| `ResolvedOption` | type | Normalized option with resolved supporting-insight paths. |
| `ResolvedInsight` | type | Finding or prior insight with resolved evidence. |
| `ResolvedEvidence` | type | Evidence with an optional resolved output path. |
| `OutputProvenance` | interface | Canonical input and decision dependencies of an output. |
| `ArtifactDescriptor` | interface | Materialized artifact metadata attached to a resolved output. |
| `ArtifactBinding` | interface | Output-to-file binding with its opaque cache token. |

## Derived helpers

| Export | Kind | Purpose |
| --- | --- | --- |
| `AnalysisIndex` | interface | Optional canonical-path lookup maps. |
| `indexAnalysis` | function | Derive analysis and record lookup maps from a resolved document. |
| `walkAnalyses` | function | Iterate resolved analysis nodes depth-first in document order. |
| `normalizeDoi` | function | Normalize common DOI spellings without validating them. |
| `collectCitedDois` | function | Collect unique normalized DOIs in resolved document order. |

## Authored ASTRA types

These are deliberately permissive TypeScript shapes for ASTRA source data;
they do not parse data or prove that it is valid. Use `validateAnalysis` or
`resolveAnalysis` for the runtime contract.

| Export | Kind | Purpose |
| --- | --- | --- |
| `Analysis` | interface | Recursive authored analysis node. |
| `Input` | interface | Authored analysis input or input alias. |
| `InputType` | type | Allowed authored input kinds. |
| `Output` | interface | Authored output or output re-export. |
| `OutputType` | type | Allowed authored output kinds. |
| `Decision` | interface | Authored decision or inherited decision reference. |
| `Option` | interface | Authored decision option. |
| `Universe` | interface | Root universe document. |
| `UniverseNode` | interface | Recursive child selection inside a universe. |
| `DecisionSelection` | interface | Verbose decision-selection representation. |
| `Insight` | interface | Authored prior insight or finding. |
| `Evidence` | interface | Literature or artifact evidence for an insight. |
| `TextQuoteSelector` | interface | Exact quote and optional surrounding text. |
| `FragmentSelector` | interface | Fragment or page locator for evidence. |
| `Recipe` | interface | Authored command, resources, and container for an output. |
| `Resources` | interface | Authored compute resource requirements. |
