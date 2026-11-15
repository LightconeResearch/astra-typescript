# ASTRA TypeScript SDK

Native TypeScript validation, resolution, and provenance checking for **ASTRA 0.1**.
The SDK is published as `@astra-spec/sdk`. This branch prepares **0.2.0-rc.1**;
pre-0.1 analyses and the SDK's former recursive model are unsupported.

The implementation is independent of Python. Python is used only by the explicit
conformance job to compare results against the pinned astra-tools reference.

## Node workflows

Node.js 20+ and Git are required for repository-backed workflows.

```ts
import { validate, resolve, status, readResult } from "@astra-spec/sdk/node";
import { indexResolvedAnalysis, selectResult } from "@astra-spec/sdk";

const validation = await validate("/path/to/analysis");
if (!validation.valid) console.error(validation.diagnostics);

const analysis = await resolve("/path/to/analysis", { offline: true });
const index = indexResolvedAnalysis(analysis);
const result = selectResult(index, "outputs.fit", "universes.baseline");
const report = await status("/path/to/analysis", { offline: true });
if (result) {
  console.log(report.statuses[result.id]);
  const bytes = await readResult("/path/to/analysis", result.id, { offline: true });
}
```

A path names the folder containing `astra.yaml`; the current folder is the default.
`resolve` and `status` validate internally and throw `InvalidAnalysisError` carrying
its `report` when a MUST rule is broken. Missing analyses and Git/cache failures
have distinct error classes. Recipes are never executed.

## One public report contract

Types and JSON match [astra-tools](https://github.com/astra-project/astra-tools):
snake_case fields, omitted optional values, explicit empty collections, and fixed
report-format versions. `ResolvedAnalysis` contains the declaration graph and all
planned results across universes. `StatusReport` separates provenance state from
byte availability. A result's owner can differ from its output's declaring analysis.

```ts
import { parseResolvedAnalysis, indexResolvedAnalysis } from "@astra-spec/sdk/reports";
const analysis = parseResolvedAnalysis(JSON.parse(serializedReport));
const index = indexResolvedAnalysis(analysis);
```

The root entry point exports report types, decoders, selectors, and host-neutral
workflows. `/reports` provides report-only access; `/resolver` exposes workflows
for an injected `AnalysisSource`. `/node` supplies filesystem/Git access. Browser
hosts can implement `SourceProvider` without a Python service.

Numbers use JavaScript `number`. Integer values beyond `Number.MAX_SAFE_INTEGER`
can lose precision, as with `JSON.parse`; no bigint or string representation is
introduced into the shared JSON contract.

See the [API](docs/api.md), [validation](docs/validation.md),
[resolution/status](docs/resolution.md), [source interfaces](docs/project-readers.md),
and [report contract](docs/reports.md) guides.

## Development and conformance

```bash
git clone --recurse-submodules https://github.com/LightconeResearch/astra-typescript.git
cd astra-typescript
npm ci
npm run reports:check
npm run spec:check
npm run typecheck
npm test
npm run test:reports:package
npm pack
```

For an existing checkout, initialize both pinned sources with
`git submodule update --init`. Generated runtime schema data is committed;
the npm tarball excludes both upstream repositories.

Normal tests run without Python. The full spec analysis suite, document fixtures,
portable report goldens, Git/source tests, and status transitions run in Node.
The separate differential check requires an environment with the pinned Python
reference installed:

```bash
uv sync --frozen --project upstream/astra-tools
ASTRA_PYTHON="$PWD/upstream/astra-tools/.venv/bin/python" npm run test:conformance
```

It compares validation diagnostics and resolved/status data against Python on the
same temporary repositories. Human diagnostic wording and diagnostic ordering
are normalized; semantically ordered arrays and report contents are retained.
It also reuses the pinned Python resolution, switch, and status scenarios,
comparing their public reports with the built TypeScript SDK. Those scenarios
read fixtures from the pinned spec submodule rather than a downloaded archive.

To review this candidate before publication, install the tarball produced by
`npm pack` into a separate project. No package is published by these commands.

BSD-3-Clause. See [LICENSE](LICENSE).
