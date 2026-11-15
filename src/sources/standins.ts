/** Large-file stand-ins and content identities, independent of filesystem/Git implementations. */
import type { Digest, FollowedFile, Tree } from "./types.js";
import { dirname, join } from "./paths.js";

const POINTER_MAX = 1024;
const decode = new TextDecoder("utf-8", { fatal: true });
async function pointer(
  reader: Tree,
  path: string,
): Promise<Uint8Array | undefined> {
  if ((await reader.stat(path))?.kind !== "file") return undefined;
  const head = await reader.read(path, POINTER_MAX + 1);
  return head.length <= POINTER_MAX ? head : undefined;
}
export interface StandIn {
  readonly name: string;
  place(path: string): string;
  recognises(reader: Tree, path: string): Promise<boolean>;
  gives(reader: Tree, path: string): Promise<Digest | undefined>;
  content(reader: Tree, path: string): Promise<FollowedFile | undefined>;
}
export class GitLfs implements StandIn {
  readonly name = "Git LFS";
  place(path: string): string {
    return path;
  }
  async recognises(reader: Tree, path: string): Promise<boolean> {
    return (await this.gives(reader, path)) !== undefined;
  }
  async gives(reader: Tree, path: string): Promise<Digest | undefined> {
    const data = await pointer(reader, path);
    if (!data) return undefined;
    let lines: string[];
    try {
      lines = decode.decode(data).split("\n");
    } catch {
      return undefined;
    }
    if (
      lines[0] !== "version https://git-lfs.github.com/spec/v1" ||
      lines.at(-1) !== ""
    )
      return undefined;
    const fields = new Map(
      lines.slice(1, -1).map((line) => {
        const space = line.indexOf(" ");
        return space < 0
          ? [line, ""]
          : [line.slice(0, space), line.slice(space + 1)];
      }),
    );
    const hash = fields.get("oid") ?? "";
    const size = fields.get("size") ?? "";
    return /^sha256:[0-9a-f]{64}$/.test(hash) && /^[0-9]+$/.test(size)
      ? { content_hash: hash, size: Number(size) }
      : undefined;
  }
  async content(_reader: Tree, _path: string): Promise<undefined> {
    return undefined;
  }
}
export class GitAnnex implements StandIn {
  readonly name = "git-annex";
  place(path: string): string {
    return path;
  }
  private async key(reader: Tree, path: string): Promise<string | undefined> {
    const entry = await reader.stat(path);
    if (entry?.kind === "symlink" && entry.target !== undefined) {
      if (entry.target.startsWith("/")) return undefined;
      const target = join(dirname(path), entry.target);
      return target !== undefined && `/${target}`.includes("/annex/objects/")
        ? target
        : undefined;
    }
    const data = await pointer(reader, path);
    if (!data) return undefined;
    const line = new TextDecoder().decode(data).replace(/\n$/, "");
    return line.startsWith("/annex/objects/") && !line.includes("\n")
      ? line
      : undefined;
  }
  async recognises(reader: Tree, path: string): Promise<boolean> {
    return (await this.key(reader, path)) !== undefined;
  }
  async gives(reader: Tree, path: string): Promise<Digest | undefined> {
    const key = await this.key(reader, path);
    if (!key) return undefined;
    const matched = /^SHA256E?-s([0-9]+)--([0-9a-f]{64})/.exec(
      key.slice(key.lastIndexOf("/") + 1),
    );
    return matched
      ? { content_hash: `sha256:${matched[2]}`, size: Number(matched[1]) }
      : undefined;
  }
  async content(reader: Tree, path: string): Promise<FollowedFile | undefined> {
    if (
      (await reader.stat(path))?.kind !== "symlink" ||
      (await this.key(reader, path)) === undefined
    )
      return undefined;
    const file = await reader.follow(path);
    return file?.path.replace(/\\/g, "/").includes("/annex/objects/")
      ? file
      : undefined;
  }
}
export class Dvc implements StandIn {
  readonly name = "DVC";
  place(path: string): string {
    return `${path}.dvc`;
  }
  async recognises(reader: Tree, path: string): Promise<boolean> {
    return (await reader.stat(this.place(path)))?.kind === "file";
  }
  async gives(_reader: Tree, _path: string): Promise<undefined> {
    return undefined;
  }
  async content(reader: Tree, path: string): Promise<FollowedFile | undefined> {
    return reader.follow(path);
  }
}
export const BUILT_IN: readonly StandIn[] = [
  new GitLfs(),
  new GitAnnex(),
  new Dvc(),
];
export interface Found {
  readonly here: boolean;
  readonly standin?: StandIn;
  readonly file?: FollowedFile;
  readonly kept_by?: string;
}
export async function look(
  reader: Tree,
  path: string,
  standins: readonly StandIn[] = BUILT_IN,
): Promise<Found> {
  for (const standin of standins) {
    if (await standin.recognises(reader, path)) {
      const file = await standin.content(reader, path);
      return {
        here: file !== undefined,
        standin,
        ...(file ? { file } : {}),
        kept_by: standin.name,
      };
    }
  }
  return { here: (await reader.stat(path))?.kind === "file" };
}
export async function digestBytes(bytes: Uint8Array): Promise<Digest> {
  const hash = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
  );
  return {
    content_hash: `sha256:${[...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    size: bytes.length,
  };
}
export async function digest(
  reader: Tree,
  path: string,
): Promise<Digest | undefined> {
  if ((await reader.stat(path))?.kind !== "file") return undefined;
  return reader.digest
    ? reader.digest(path)
    : digestBytes(await reader.read(path));
}
/** The content's identity, never the pointer file's bytes. */
export async function content(
  reader: Tree,
  path: string,
  found: Found,
): Promise<Digest | undefined> {
  if (!found.standin) return digest(reader, path);
  const given = await found.standin.gives(reader, path);
  if (given) return given;
  if (!found.file) return undefined;
  return found.file.digest
    ? found.file.digest()
    : digestBytes(await found.file.read());
}
