/** The minimal read-only storage contract required by `resolveAnalysis`. */
export interface ProjectReader {
  readText(path: string): Promise<string>;
  stat(path: string): Promise<ProjectEntry | undefined>;
  readDirectory(path: string): Promise<ProjectDirectoryEntry[]>;
}

export type ProjectEntry =
  | {
      type: "file";
      /** Non-negative safe integer file size in bytes. */
      size: number;
      /** Non-negative safe integer Unix time in milliseconds. */
      modifiedAtMs: number;
    }
  | { type: "directory" };

export interface ProjectDirectoryEntry {
  /** One immediate child name, never a path. */
  name: string;
  type: "file" | "directory";
}

/** Adapter signal for backend-specific root escapes such as symlinks. */
export class ProjectPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectPathError";
  }
}

const INVALID_SEGMENT = /^(?:|\.|\.\.)$/;

/**
 * Validate a path at the reader boundary. The empty string denotes the root;
 * every other path is normalized POSIX and project-relative.
 */
export function assertProjectPath(path: string): void {
  if (path === "") return;
  if (path.startsWith("/") || path.includes("\\")) {
    throw new Error(`Project path must be normalized and relative: ${path}`);
  }
  if (path.split("/").some((segment) => INVALID_SEGMENT.test(segment))) {
    throw new Error(`Project path must be normalized and relative: ${path}`);
  }
}

/** Join normalized project paths, rejecting any lexical root escape. */
export function joinProjectPath(...paths: string[]): string {
  const result: string[] = [];
  for (const path of paths) {
    if (path.startsWith("/") || path.includes("\\")) {
      throw new Error(`Project path escapes the project root: ${path}`);
    }
    for (const segment of path.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (!result.length) {
          throw new Error(`Project path escapes the project root: ${paths.join("/")}`);
        }
        result.pop();
      } else {
        result.push(segment);
      }
    }
  }
  return result.join("/");
}

export function projectDirname(path: string): string {
  assertProjectPath(path);
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function isValidProjectEntry(entry: ProjectEntry): boolean {
  if (entry.type === "directory") return true;
  return Number.isSafeInteger(entry.size)
    && entry.size >= 0
    && Number.isSafeInteger(entry.modifiedAtMs)
    && entry.modifiedAtMs >= 0;
}
