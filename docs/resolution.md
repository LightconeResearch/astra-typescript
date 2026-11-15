# Resolve, inspect status, and read resources

```ts
import { resolve, status, readResult } from "@astra-spec/sdk/node";
import { indexResolvedAnalysis, selectResult } from "@astra-spec/sdk";

const folder = "/path/to/analysis";
const analysis = await resolve(folder, { offline: true });
const index = indexResolvedAnalysis(analysis);
const selected = selectResult(index, "outputs.fit", "universes.baseline");
const report = await status(folder, { offline: true });
if (selected) {
  console.log(selected.command, selected.places, report.statuses[selected.id]);
  const bytes = await readResult(folder, selected.id, { offline: true });
}
```

## Resolved data

`resolve` returns the same JSON shape as Python's `astra.api.resolve`. Analyses
form a flat declaration graph; `""` identifies the driver. Declaration cycles
and aliases are retained, while canonical keys choose the shortest declaration
chain with alphabetical tie-breaking. Planned results are ordered after their
result dependencies.

All universes are resolved together. Results identify their output, optional
universe, all places, ordered input sources, and a rendered command when they can
be built entirely from working-tree files. Driven subanalysis results belong to
the driver's universes; results built once belong to their output's analysis.
Pins can select results owned by another analysis or universe.

Switches and inheritance instructions are applied internally. `Result.inputs`
holds effective dependencies; `Output.inputs` and `Analysis.switches` retain
authored dependency edges, including unplanned branches. An output with no planned
result is not necessarily inactive. Use the [graph helpers](reports.md#lookups-and-selections)
to navigate the public model without parsing IDs.

## Status

`status` returns `StatusReport`. Each planned result is `unchanged`, `stale`, or
`missing`; its byte availability is independently `present` or `absent`.
For results, `present` means the recorded content is available, rather than
merely that some file exists at the result path.

The checker validates records, reads the analysis at each record's generation
commit, compares the declaration and directly selected decisions/switch steps,
checks input content, and propagates stale upstream results. Cosmetic label and
description changes do not stale a result. Records retain the recorded execution
environment and runner; the checker never executes recipes.

Missing or unfetched result bytes do not alone stale its record. Git LFS and
SHA-256 git-annex pointers can identify input content without fetching it; DVC
and non-SHA-256 annex content require actual bytes for content comparison.
Fetching these large files is a host/runner operation.

`resolve` and `status` currently open separate reads. Their `head` fields identify
the Git commit, not uncommitted file contents; equal HEAD does not establish a
single working-tree snapshot.

## Resource reads

`readInput(folder, inputRef, options?)` and `readResult(folder, resultId, options?)`
return actual content bytes. They follow the model's owning repository/commit,
so historical paths are read from Git objects rather than accidentally from the
current working tree. A stand-in whose content is unavailable returns
`undefined`; pointer text is never returned as content.

A result may have multiple places; select one with `placeIndex`. Resource access
validates/resolves the analysis internally. It reads available content independently
of provenance state; use `status` when deciding whether that content is suitable
for publication or downstream work.
