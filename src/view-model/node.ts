// Node filesystem adapter for the project-view-model projector. Import from
// `@astra-spec/sdk/view-model/node`; the main entry stays platform-neutral so
// browser hosts never pull in `node:fs`.

import { readFile, readdir, stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import type {
  DirectoryEntry,
  FileStatInfo,
  ProjectFileAccess,
} from "./access.js";

export function createNodeFileAccess(projectRoot: string): ProjectFileAccess {
  const rooted = (path: string): string => resolvePath(projectRoot, path);
  return {
    async readText(path: string): Promise<string> {
      return readFile(rooted(path), "utf8");
    },
    async stat(path: string): Promise<FileStatInfo | undefined> {
      try {
        const info = await stat(rooted(path), { bigint: true });
        return {
          type: info.isDirectory() ? "directory" : "file",
          size: Number(info.size),
          mtimeMs: Number(info.mtimeNs / 1_000_000n),
          mtimeNs: info.mtimeNs,
        };
      } catch {
        return undefined;
      }
    },
    async listDirectory(path: string): Promise<DirectoryEntry[]> {
      try {
        const entries = await readdir(rooted(path), { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
        }));
      } catch {
        return [];
      }
    },
  };
}
