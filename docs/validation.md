# Validate an ASTRA project

`validateAnalysis()` answers one question: is this complete project valid?
It recursively reads the root `astra.yaml`, path-backed analyses, and every
universe file, then applies the bundled structural schema and project-level
semantic and reference checks.

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

## Result contract

```ts
interface AnalysisValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly file: string;
  readonly path?: string;
}
```

Each issue identifies the project-relative YAML file and, when available, the
authored field path. The `code` is stable for programmatic handling; `message`
is intended for people.

Malformed YAML, non-JSON-compatible YAML values, schema violations, broken
references, invalid aliases, and inconsistent universe selections all produce
`{ valid: false, issues }`. All root universe files are checked, not only the
one that would be selected for resolution.

## Invalid project or unreadable project?

Authored problems are validation results. Operational failures throw
`ProjectLoadError` because the SDK could not safely answer the question. These
include an unavailable backend, malformed reader responses, and a
backend-specific escape from the chosen project root.

```ts
import { ProjectLoadError, validateAnalysis } from "@astra-spec/sdk";

try {
  const result = await validateAnalysis(reader);
  // Inspect result.valid and result.issues.
} catch (error) {
  if (error instanceof ProjectLoadError) {
    console.error(error.code, error.path, error.message);
  }
}
```

`ASTRA_SPEC_VERSION` reports the version of the canonical schema bundled into
the installed SDK.
