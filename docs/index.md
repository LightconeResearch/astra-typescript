# ASTRA TypeScript SDK

The SDK implements ASTRA 0.1 validation, resolution, and provenance checking in
TypeScript. Version 0.2 is a breaking cutover; analyses before ASTRA 0.1 are unsupported.

```ts
import { validate, resolve, status } from "@astra-spec/sdk/node";

const validation = await validate("/path/to/analysis");
const analysis = await resolve("/path/to/analysis");
const report = await status("/path/to/analysis");
```

Node workflows require Node 20+ and Git. They never execute recipes or invoke
Python. The root entry point provides the same report model and host-neutral
workflows for an injected repository provider.

| Goal | Guide |
| --- | --- |
| Check syntax, schema, references and semantic rules | [Validation](validation.md) |
| Inspect all universes, results, provenance and resources | [Resolution and status](resolution.md) |
| Supply repository access in another host | [Sources](project-readers.md) |
| Decode transported data and build graph lookups | [Report contract](reports.md) |
| Find exports, options and errors | [API reference](api.md) |

The shared report schemas come from a pinned astra-tools submodule. Authored
schemas, rules, and conformance cases come from a pinned astra-spec submodule.
Python is an explicit development/CI oracle, not a runtime dependency.

This checkout prepares 0.2.0-rc.1. Build an npm tarball with `npm pack` to test the
candidate before publication; see the [repository instructions](https://github.com/LightconeResearch/astra-typescript#development-and-conformance).
