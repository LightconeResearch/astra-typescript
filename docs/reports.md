# Python report contract

`@astra-spec/sdk/reports` exposes the ASTRA 0.1 report model returned by
`astra.api.validate`, `astra.api.resolve`, and `astra.api.status`. It provides
generated TypeScript types and runtime decoders, with the same JSON field names
and version markers as Python.

The root entry point also exports this contract and the host-neutral ASTRA 0.1
engine. `/reports` provides transport-only access; `/node` provides native
filesystem/Git workflows. SDK 0.2 supports ASTRA 0.1 exclusively.

## Decode a report

```ts
import {
  parseResolvedAnalysis,
  ReportValidationError,
  type ResolvedAnalysis,
} from "@astra-spec/sdk/reports";

const candidate: unknown = JSON.parse(serializedReport);

try {
  const analysis: ResolvedAnalysis = parseResolvedAnalysis(candidate);
  console.log(analysis.analyses, analysis.results);
} catch (error) {
  if (error instanceof ReportValidationError) {
    console.error(error.report, error.issues);
  } else {
    throw error;
  }
}
```

Use `parseValidationReport` or `parseStatusReport` for those report kinds.
The parsers accept already-deserialized values, perform no project I/O, and
return the original object unchanged. They check JSON values and the structural
report schema, including required collections and the report version. They do
not resolve references or repeat ASTRA's semantic validation.

The `isResolvedAnalysis`, `isValidationReport`, and `isStatusReport` type guards
perform the same checks and return a boolean.

## Lookups and selections

Build indexes when a consumer needs repeated lookups. Indexes hold the original
objects and derive ownership from the analysis collections, without parsing
element refs or result IDs:

```ts
import {
  indexResolvedAnalysis,
  parseResolvedAnalysis,
  selectResult,
  getResultOwner,
  walkResultDependencies,
} from "@astra-spec/sdk/reports";

const report = parseResolvedAnalysis(candidate);
const index = indexResolvedAnalysis(report);
const output = index.elementByRef.get("stage.outputs.fit");

if (output?.collection === "outputs") {
  console.log(output.analysis.key, output.element.format);
}

const fit = selectResult(index, "stage.outputs.fit", "universes.baseline");
if (fit) console.log(getResultOwner(index, fit.id)?.key);

const comparison = selectResult(index, "outputs.comparison", "universes.alternate");
if (comparison) console.log([...walkResultDependencies(index, comparison.id)]);
```

In the upstream `driven` fixture, the fit output belongs to analysis `stage`,
while its baseline result belongs to the root analysis (`""`). The alternate
comparison reads both the alternate fit and a result pinned to the stage's own
local universe. Following result dependencies preserves both references.

`ResolvedAnalysisIndex` provides four readonly maps:

| Map | Lookup |
| --- | --- |
| `analysisByKey` | Analysis key to analysis, including root key `""` |
| `elementByRef` | Element ref to an `IndexedElement` with `collection`, declaring `analysis`, and typed `element` |
| `resultById` | Result ID to result |
| `resultsByOutput` | Output ref to all its planned results, in report order |

`IndexedElement` is discriminated by its `ElementCollection`: `inputs`,
`outputs`, `switches`, `decisions`, `prior_insights`, `findings`, or `universes`.

| Helper | Behavior |
| --- | --- |
| `getDeclaredAnalysis(index, analysisKey, declarationId)` | Follow one local declaration, including an alias back to the root |
| `walkAnalyses(index, startKey = "")` | Depth-first declaration walk; each analysis appears once, so cycles terminate |
| `getResultOwner(index, resultId)` | Find the universe's declaring analysis, or the output's for a result built once |
| `getResult(index, outputRef, universeRef?)` | Exact output/universe lookup; omitting the universe requests only a result built once |
| `selectResult(index, outputRef, universeRef)` | For a known universe, select the exact result or fall back to that output's result built once |
| `getSelectedOption(index, universeRef, decisionRef)` | Find the option in the universe's effective selection; absence remains `undefined` |
| `walkResultDependencies(index, resultId)` | Depth-first walk of upstream results in input order, excluding the starting result and yielding each dependency once |
| `traceResultProvenance(index, resultId)` | Decisions with selected options and terminal inputs, retaining effective universes and every dependency route |
| `getEvidenceBindings(index, insightRef, evidenceIndex, universeRef?)` | Artifact evaluations, optionally filtered by evaluation universe while preserving explicit pins |
| `getEvidence(index, insightRef, evidenceIndex)` | Find an item by its insight ref and zero-based evidence index |
| `getEvidenceOutput(index, insightRef, evidenceIndex)` | Follow the item's authored address through its owner's declarations to a concrete output, even when it has no planned result |
| `getCitedResults(index, insightRef, evidenceIndex)` | Return the item's cited results in citation order, including results from different universes |

Analysis traversal retains the original `declares` maps, including repeated
aliases. Dependency traversal follows explicit result IDs through pins and
terminates on cycles. It uses depth-first input order; the report's `results`
array retains its dependency-first order.

There is no implicit universe choice or inferred default option. A missing
result does not establish that an output is inactive. `getCitedResults` returns
all effective citations together for compatibility. `getEvidenceBindings` selects
bindings by evaluation universe, including switches whose cases are built once.
Explicitly pinned evidence and universe-independent bindings remain applicable
regardless of the requested universe. It returns `undefined` for older reports
without bindings or for DOI evidence; an empty array means no evaluation matched.

Each binding has an optional `universe` (evaluation context), `output` (canonical
concrete target), `target_universe` (effective context after pins), and `result`
(planned result ID). A binding without an output records a switch taking no case.
A target without a result is still useful for navigation. `cites` is the ordered
unique list of result IDs from the bindings.

`getEvidenceOutput` follows local output names and declaration chains in the
insight's declaring analysis, including aliases back to the root. Its purpose is
output identity: a `#universe` pin does not change that identity. It does not
select switch cases; use bindings for those. Unknown or malformed addresses
return `undefined`.

`traceResultProvenance` includes the seed's decisions, then follows effective
result inputs in depth-first order. Each decision occurrence includes its result,
decision, effective universe and selected option (when present). Each terminal
input occurrence includes its result and input. Both retain `route`, the ordered
`{ result, source }` edges from the seed. Shared dependencies occur once per route;
two pins never collapse into one decision. Cycles terminate by excluding results
already on the current route. Consumers can group occurrences for display after
tracing, without losing route or universe information.

Selected switch chains also contribute their decisions, following authored input
pins and then case pins. These occurrences belong to the consuming result, and
their route includes the effective input edge on which the switch was evaluated.
Older reports without authored references retain output-decision tracing.

### Authored dependencies

New reports also expose `Output.inputs` and `Analysis.switches`, including
unplanned branches. They are optional for compatibility with older reports;
new resolvers always emit them. An `AuthoredReference` contains `entry` (the
address as written), `target` (canonical input/output/switch ref), and optional
`universe` (the resolved pin). A `Switch` contains its canonical `ref`, `decision`
ref and all `cases`, keyed by option ID. Switch refs use the `switches` collection
and are indexed by `elementByRef`; switches are never concrete outputs or results.
Use these edges for authored graphs and `Result.inputs` for effective execution
provenance. A dependency's presence in the authored graph does not imply a result
is planned or active in any particular universe.

These helpers expect a semantically valid resolved report. Unknown lookups
return `undefined` or an empty traversal/list; dangling references are skipped.
Indexing rejects duplicate analysis keys, element refs, and result IDs with
`ReportIndexError`. Its `code` is `DUPLICATE_ANALYSIS_KEY`,
`DUPLICATE_ELEMENT_REF`, or `DUPLICATE_RESULT_ID`, and `key` identifies the
duplicate. `ReportIndexErrorCode` describes these codes. The index and selections
are derived data; the serialized Python
report is unchanged. Treat the report and index as readonly after indexing.

## JSON conventions

- Fields use Python's snake_case spelling.
- Optional fields are omitted rather than set to `null` or `undefined`.
- Required arrays and maps remain present when empty.
- Unknown fields are retained for additive compatibility. Their values must be
  JSON data; `null` is allowed in unknown fields.
- Numbers must be finite. Cyclic objects and non-JSON values are rejected.
- Types expose readonly fields, arrays, and maps. Decoding does not freeze or
  clone objects.

The version constants exported here identify the report format:

| Constant | Value |
| --- | --- |
| `RESOLVED_ANALYSIS_SCHEMA_VERSION` | `astra-tools.resolved-analysis.v1` |
| `VALIDATION_REPORT_SCHEMA_VERSION` | `astra-tools.validation-report.v1` |
| `STATUS_REPORT_SCHEMA_VERSION` | `astra-tools.status-report.v1` |

These are independent of an analysis's authored `spec_version`. The resolved
analysis holds a flat analysis graph and planned results across universes.
`Evidence.artifact` retains the authored address in its declaring analysis's
scope, including switches and pins; `Evidence.cites` identifies effective
planned results. Status keeps result state separate from byte availability.

## Exports

The generated model names match Python:

| Group | Types |
| --- | --- |
| Reports | `ResolvedAnalysis`, `ValidationReport`, `StatusReport`, `Report` (their union) |
| Analysis and results | `Analysis`, `Commit`, `Input`, `Output`, `Decision`, `Option`, `Universe`, `Result`, `Source`, `Place`, `Resources` |
| Claims and evidence | `Insight`, `Evidence`, `TextQuoteSelector`, `FragmentSelector` |
| Diagnostics and status | `Diagnostic`, `Location`, `Status`, `Bytes`, `EvidenceStatus` |
| Provenance | `ProvenanceRecord`, `Generation`, `RecordedInput`, `Environment`, `Runner` |

`ReportValidationError` has a `report` kind and an `issues` array. Each
`ReportValidationIssue` has `code`, `path`, and `message`. Paths are JSON
Pointers, with `""` for the root. Codes are `INVALID_JSON`,
`UNSUPPORTED_SCHEMA_VERSION`, or `SCHEMA_<KEYWORD>` for a JSON Schema failure,
such as `SCHEMA_REQUIRED` or `SCHEMA_TYPE`. Missing-field paths include the
missing property. Messages are descriptive; use the code and path in programs.
`ReportValidationIssueCode` describes these codes.

## Pinned upstream contract

`upstream/astra-tools` is a Git submodule pinned to the `0.3.0rc3` release at
[`463b6a1`](https://github.com/astra-project/astra-tools/commit/463b6a151273dbd69594336c7968f6b84aa55962).
The generator reads its report schema directly, and tests read its golden
reports directly. The upstream fixture manifest separately records the Python
oracle and spec revisions that produced those reports. These are report-decoding
fixtures; passing them does not establish resolver conformance.

Clone with `git clone --recurse-submodules`, or initialize an existing checkout:

```bash
git submodule update --init upstream/astra-tools
```

Generation and checking use Node and Git. Once the submodule is initialized,
they work offline and require no Python:

```bash
npm run reports:generate
npm run reports:check
```

To update the contract, fetch astra-tools, select the intended commit in the
submodule, regenerate the TypeScript, and commit both the submodule pointer and
generated files together:

```bash
git -C upstream/astra-tools fetch origin
git -C upstream/astra-tools checkout --detach <commit>
npm run reports:generate
git add upstream/astra-tools src/reports/types.ts src/reports/schema.ts
```

The generator rejects uncommitted changes to its schema and fixture inputs and
schema features it does not support. CI initializes the pinned submodule, checks
generated output, decodes all six reports, and verifies the built npm package's
runtime imports and TypeScript declarations. Advancing the upstream repository
does not change the pin automatically.

The npm package contains the built SDK and embedded schema data. Its users need
neither the submodule nor Python. Node repository workflows require Git; report
decoders and selectors need no Git executable. The submodules are used only to
develop, test, and build the SDK.
