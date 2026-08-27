# Project readers

The SDK knows ASTRA project semantics, not how a host stores files. Both public
workflows read through one small asynchronous interface:

```ts
interface ProjectReader {
  readText(path: string): Promise<string>;
  stat(path: string): Promise<ProjectEntry | undefined>;
  readDirectory(path: string): Promise<ProjectDirectoryEntry[]>;
}
```

## Node

The Node entry point provides a filesystem-backed implementation. Pass the
project directory, not the path to `astra.yaml`:

```ts
import { createNodeProjectReader } from "@astra-spec/sdk/node";

const reader = createNodeProjectReader("/path/to/project");
```

It rejects symbolic links that escape the chosen root and decodes text as
strict UTF-8.

## Other hosts

JupyterLab, editors, remote stores, and browser-local integrations implement
the same contract with their native storage API. The SDK owns all ASTRA
loading, parsing, traversal, and validation logic; adapters should not
reimplement it.

### Paths

- Every path is normalized POSIX and relative to the chosen project root.
- The empty string `""` denotes the project root.
- `readDirectory()` returns immediate children with bare names; ordering is
  irrelevant.
- Adapters must prevent backend-specific escapes and throw `ProjectPathError`
  when one is attempted.

The exported `assertProjectPath()`, `joinProjectPath()`, and
`projectDirname()` helpers keep adapter path handling consistent with the SDK.

### Reads and metadata

`readText()` returns a string for one existing UTF-8 file. It rejects missing
paths, directories, decoding failures, and backend errors.

`stat()` returns `undefined` **only** when the path does not exist:

```ts
type ProjectEntry =
  | {
      type: "file";
      size: number;
      modifiedAtMs: number;
    }
  | { type: "directory" };
```

File size and Unix modification time in milliseconds must be non-negative safe
integers. `readDirectory()` returns immediate entries shaped as
`{ name, type }`, where `type` is `"file"` or `"directory"`.

The SDK validates every adapter response. Malformed responses and ordinary
backend exceptions become `ProjectLoadError` with `READ_FAILED`;
`ProjectPathError` becomes `PROJECT_PATH_ESCAPE`.

!!! note

    Deterministic output locations eliminate directory scans for artifacts,
    but `readDirectory()` remains necessary to discover universe files.
