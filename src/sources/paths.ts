/** Normalize a path lexically; undefined denotes an escape above repository root. */
export function join(folder: string, path: string): string | undefined {
  const parts: string[] = [];
  for (const part of [...folder.split("/"), ...path.split("/")]) {
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else if (part !== "" && part !== ".") parts.push(part);
  }
  return parts.join("/");
}
export function liesInside(path: string, folder: string): boolean {
  return folder ? path.startsWith(`${folder}/`) : path !== "";
}
export function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}
/** Resolve relative submodule URLs with Git's scp-like URL semantics. */
export function resolveRemote(base: string, url: string): string {
  if (!url.startsWith("./") && !url.startsWith("../")) return url;
  base = base.replace(/\/$/, "");
  let colon = false;
  while (url.startsWith("./") || url.startsWith("../")) {
    if (url.startsWith("./")) {
      url = url.slice(2);
      continue;
    }
    url = url.slice(3);
    let cut = base.lastIndexOf("/");
    if (cut < 0 && base.includes(":")) {
      cut = base.lastIndexOf(":");
      colon = true;
    }
    base = cut >= 0 ? base.slice(0, cut) : ".";
  }
  return `${base}${colon ? ":" : "/"}${url}`.replace(/\/$/, "");
}
