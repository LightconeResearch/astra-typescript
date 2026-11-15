# Repository sources

The host-neutral engine takes an `AnalysisSource`:

```ts
interface AnalysisSource {
  readonly reader: Tree;
  readonly folder: string;
  readonly provider: SourceProvider;
}
```

`folder` is the analysis's repository-relative directory, with `""` for the tree
root. Paths use POSIX separators. A `Tree` represents a working tree or commit
snapshot and supplies binary reads, exact entry kinds, tracking information,
repository ownership, and explicit stand-in content access. It distinguishes
files, folders, symlinks and Git links. Regular source reads never follow symlinks.

`SourceProvider` supplies declaration resolution, historical trees, remote commits
and offline behavior. `Repository` supplies HEAD/commit queries, ancestry,
default remote and tracked paths. `FollowedFile` supports content reads and an
optional streaming digest; `Tree` can also supply streaming digests.

Browser and Jupyter hosts can implement these interfaces using their repository
service. A filesystem-only Contents API cannot provide commit, tracking and
submodule facts by itself. The engine applies ASTRA semantics in TypeScript;
the provider supplies bytes and Git facts.

For Node, use the built-in provider:

```ts
import { NodeSourceProvider } from "@astra-spec/sdk/node";
import { resolve } from "@astra-spec/sdk/resolver";

const provider = new NodeSourceProvider({ offline: true });
const source = await provider.worktree("/path/to/analysis");
const analysis = await resolve(source);
```

The Node provider uses Git directly, reads commit objects without checking them
out, and uses checked-out submodules before cached remotes where possible. It
never invokes Python, recipes, LFS, git-annex, or DVC commands. Content hashing
and pointer recognition are streamed/bounded where the Node backend supports it.

Source instances cache directory/object lookups for one operation. Open a fresh
source to observe structural file changes; a provider is not an atomic filesystem
snapshot.
