// Pluggable file access for the project-view-model projector. Hosts supply an
// implementation for their environment: Node `fs` in VSCode and the MyST
// build, the Jupyter contents API in the browser. All paths are POSIX and
// project-root-relative ("" is the root directory itself).

export interface FileStatInfo {
  type: "file" | "directory";
  size: number;
  /** Millisecond mtime; always present. */
  mtimeMs: number;
  /** Nanosecond mtime when the platform provides it (Node bigint stats). */
  mtimeNs?: bigint;
}

export interface DirectoryEntry {
  name: string;
  type: "file" | "directory";
}

export interface ProjectFileAccess {
  /** Read a UTF-8 text file. Throws when the file cannot be read. */
  readText(path: string): Promise<string>;
  /** Stat a path, or resolve `undefined` when it does not exist. */
  stat(path: string): Promise<FileStatInfo | undefined>;
  /** List a directory, or resolve `[]` when it does not exist. */
  listDirectory(path: string): Promise<DirectoryEntry[]>;
}

export function joinPath(...segments: string[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    for (const part of segment.split("/")) {
      if (!part || part === ".") continue;
      if (part === ".." && parts.length && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else {
        parts.push(part);
      }
    }
  }
  return parts.join("/");
}

export function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

export function fileExtension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** True when a normalized project-relative path escapes the project root. */
export function isExternalPath(path: string): boolean {
  return path === ".." || path.startsWith("../");
}
