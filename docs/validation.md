# Validate an analysis

```ts
import { validate, resolve, InvalidAnalysisError } from "@astra-spec/sdk/node";

const report = await validate("/path/to/analysis", { offline: true });
for (const item of report.diagnostics) {
  console.log(item.code, item.level, item.location, item.related);
}

try {
  const analysis = await resolve("/path/to/analysis");
} catch (error) {
  if (error instanceof InvalidAnalysisError) console.error(error.report);
  else throw error;
}
```

`validate` returns `ValidationReport`: `root`, `valid`, `diagnostics`, `unchecked`,
and a fixed `schema_version`. A MUST violation is an error; SHOULD violations are
warnings and do not make the analysis invalid. Human wording can differ from the
Python reference; diagnostic codes, levels, locations and related locations are
the programmatic contract.

Validation applies YAML 1.2 core parsing, JSON-compatible values, authored schemas,
and semantic rules across the complete declared analysis graph. It checks all
universes, including inheritance, imports, driving, pins, switches, decision
usage, planned results, paths, tracking, and declared commits. It implements the
current pinned validator catalogue (`unchecked` is empty).

Locations use repository-relative files and JSON Pointers, with source line and
column where available. A diagnostic from a commit tree includes its commit and
remote repository where applicable. Provenance JSON schema diagnostics have no
YAML source positions.

Analyses must be in a Git working tree; an otherwise readable analysis outside
one returns `NOT_IN_REPOSITORY`. A missing `astra.yaml` is `NoAnalysisError`.
Analyses outside the 0.1 minor version are rejected with
`UNSUPPORTED_SPEC_VERSION`. Null authored fields are checked as written.

The SDK runs the pinned spec's full document and analysis conformance suites.
Resolution and status validate internally, so a separate validation call is only
needed when the caller wants a report instead of an exception.
