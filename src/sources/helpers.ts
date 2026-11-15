import type { Repository, Tree } from "./types.js";
import { join } from "./paths.js";
/** POSIX relative path calculation without filesystem access. */
export function relativePath(from: string, to: string): string {
  const source = from === "." || from === "" ? [] : from.split("/");
  const target = to === "." || to === "" ? [] : to.split("/");
  let common = 0;
  while (common < source.length && source[common] === target[common])
    common += 1;
  return (
    [...source.slice(common).map(() => ".."), ...target.slice(common)].join(
      "/",
    ) || "."
  );
}
export async function analysisBelow(
  reader: Tree,
  folder: string,
  path: string,
): Promise<string | undefined> {
  const parts = path.split("/").slice(0, -1);
  for (let count = 1; count <= parts.length; count += 1) {
    const inner = join(folder, parts.slice(0, count).join("/"));
    if (
      inner !== undefined &&
      (await reader.stat(inner ? `${inner}/astra.yaml` : "astra.yaml"))
        ?.kind === "file"
    )
      return inner;
  }
  return undefined;
}
export async function inRepository(
  reader: Tree,
  folder: string,
  path: string,
): Promise<{ repository: Repository; path: string }> {
  const held = await reader.holding(folder);
  return {
    repository: held.repository,
    path:
      join(held.folder, relativePath(folder, path)) ??
      relativePath(folder, path),
  };
}
