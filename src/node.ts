import { readFileSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { parseYamlString, type Dict } from "./helpers.js";
import {
  assertProjectPath,
  ProjectPathError,
  type ProjectDirectoryEntry,
  type ProjectEntry,
  type ProjectReader,
} from "./project-reader.js";
import type { JsonSchema } from "./schema/index.js";
import {
  validateAnalysisData,
  validateUniverseData,
  type ValidateOptions,
} from "./validation/schema.js";

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Create the bundled Node adapter rooted at one ASTRA project directory. */
export function createNodeProjectReader(projectRoot: string): ProjectReader {
  const root = resolve(projectRoot);
  let realRoot: Promise<string> | undefined;
  const resolvedRoot = (): Promise<string> => {
    realRoot ??= realpath(root);
    return realRoot;
  };

  const assertContained = (base: string, target: string, path: string): string => {
    const fromRoot = relative(base, target);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new ProjectPathError(`Project path escapes the project root: ${path}`);
    }
    return target;
  };
  const rooted = (path: string): string => {
    try {
      assertProjectPath(path);
    } catch {
      throw new ProjectPathError(`Project path must be normalized and relative: ${path}`);
    }
    return assertContained(root, resolve(root, path), path);
  };
  const existing = async (path: string): Promise<string> => {
    const target = rooted(path);
    const [canonicalRoot, resolvedTarget] = await Promise.all([
      resolvedRoot(),
      realpath(target),
    ]);
    return assertContained(canonicalRoot, resolvedTarget, path);
  };
  const entryFor = async (path: string): Promise<ProjectEntry> => {
    const info = await stat(await existing(path));
    if (info.isDirectory()) return { type: "directory" };
    if (!info.isFile()) throw new Error(`Unsupported project entry type: ${path}`);
    const size = Number(info.size);
    const modifiedAtMs = Math.trunc(info.mtimeMs);
    if (!Number.isSafeInteger(size) || size < 0
      || !Number.isSafeInteger(modifiedAtMs) || modifiedAtMs < 0) {
      throw new Error(`Invalid file metadata: ${path}`);
    }
    return { type: "file", size, modifiedAtMs };
  };

  return {
    async readText(path: string): Promise<string> {
      const bytes = await readFile(await existing(path));
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    },
    async stat(path: string): Promise<ProjectEntry | undefined> {
      try {
        return await entryFor(path);
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
    async readDirectory(path: string): Promise<ProjectDirectoryEntry[]> {
      const directory = await existing(path);
      const entries = await readdir(directory, { withFileTypes: true });
      return Promise.all(entries.map(async (entry): Promise<ProjectDirectoryEntry> => {
        if (entry.isFile()) return { name: entry.name, type: "file" };
        if (entry.isDirectory()) return { name: entry.name, type: "directory" };
        const childPath = path ? `${path}/${entry.name}` : entry.name;
        const child = await entryFor(childPath);
        return { name: entry.name, type: child.type };
      }));
    },
  };
}

export function loadYaml(filePath: string): Dict {
  return parseYamlString(readFileSync(filePath, "utf8"));
}

export async function validateAnalysisFile(
  filePath: string,
  options: ValidateOptions = {},
): Promise<string[]> {
  return validateAnalysisData(loadYaml(filePath), options);
}

export async function validateUniverseFile(
  filePath: string,
  options: ValidateOptions = {},
): Promise<string[]> {
  return validateUniverseData(loadYaml(filePath), options);
}

export async function isValidAnalysis(
  filePath: string,
  options: ValidateOptions = {},
): Promise<boolean> {
  return (await validateAnalysisFile(filePath, options)).length === 0;
}

export async function isValidUniverse(
  filePath: string,
  options: ValidateOptions = {},
): Promise<boolean> {
  return (await validateUniverseFile(filePath, options)).length === 0;
}

export type { JsonSchema, ValidateOptions };
