# Python report contract

`@astra-spec/sdk/reports` exposes the ASTRA 0.1 report model returned by
`astra.api.validate`, `astra.api.resolve`, and `astra.api.status`. It provides
generated TypeScript types and runtime decoders, with the same JSON field names
and version markers as Python.

This entry point establishes the contract for the SDK 0.2 migration. The existing
root and `/node` project workflows still implement ASTRA 0.0.14; native ASTRA 0.1
validation, resolution, and status are later stages of that migration.

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

## Pinned upstream artifacts

The schema and two portable fixture cases are vendored from astra-tools commit
[`5504a2d`](https://github.com/astra-project/astra-tools/commit/5504a2d2a212921c9009e94c0b4b5fddca3ff9d4).
`vendor/astra-tools/source.json` records the revision and each artifact's SHA-256.
The upstream fixture manifest separately records the Python oracle and spec
revisions used to produce its six reports. These are report-decoding fixtures;
passing them does not establish resolver conformance.

Generation and checking are offline and require no Python:

```bash
npm run reports:generate
npm run reports:check
```

To refresh the vendored files, update the pinned revision in `source.json` and
read that committed revision from a local astra-tools clone:

```bash
npm run reports:sync -- ../astra-tools
```

Sync reads Git objects, so uncommitted files in that clone are excluded. Review
artifact and generated-code changes together. The generator rejects schema
features it does not support. CI checks the hashes and generated output, decodes
all six reports, and verifies the built npm package's runtime imports and
TypeScript declarations.
