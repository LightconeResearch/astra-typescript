// Node filesystem adapter for the project-view-model projector. Import from
// `@astra-spec/sdk/view-model/node`; the main entry stays platform-neutral so
// browser hosts never pull in `node:fs`.

import { readFile, readdir, realpath, stat } from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";

import type {
  DirectoryEntry,
  FileStatInfo,
  ProjectFileAccess,
} from "./access.js";

class ProjectPathError extends Error {}

export function createNodeFileAccess(projectRoot: string): ProjectFileAccess {
  const root = resolvePath(projectRoot);
  const realRoot = realpath(root);
  const assertContained = (base: string, target: string, path: string): string => {
    const fromRoot = relative(base, target);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)
      || isAbsolute(fromRoot)) {
      throw new ProjectPathError(`Project path escapes the project root: ${path}`);
    }
    return target;
  };
  const rooted = (path: string): string => {
    if (isAbsolute(path)) {
      throw new ProjectPathError(`Project path must be relative: ${path}`);
    }
    return assertContained(root, resolvePath(root, path), path);
  };
  const existingRooted = async (path: string): Promise<string> => {
    const target = rooted(path);
    const [resolvedRoot, realTarget] = await Promise.all([realRoot, realpath(target)]);
    return assertContained(resolvedRoot, realTarget, path);
  };
  return {
    async readText(path: string): Promise<string> {
      return readFile(await existingRooted(path), "utf8");
    },
    async stat(path: string): Promise<FileStatInfo | undefined> {
      try {
        const info = await stat(await existingRooted(path), { bigint: true });
        return {
          type: info.isDirectory() ? "directory" : "file",
          size: Number(info.size),
          mtimeMs: Number(info.mtimeNs / 1_000_000n),
          mtimeNs: info.mtimeNs,
        };
      } catch (error) {
        if (error instanceof ProjectPathError) throw error;
        return undefined;
      }
    },
    async listDirectory(path: string): Promise<DirectoryEntry[]> {
      try {
        const entries = await readdir(await existingRooted(path), { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
        }));
      } catch (error) {
        if (error instanceof ProjectPathError) throw error;
        return [];
      }
    },
  };
}
