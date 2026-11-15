/** Node adapters for worktrees, Git object trees and cached remote commits. */
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import {
  isAbsolute,
  join as nativeJoin,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  GitRepository,
  digestBlob,
  git,
  readBlob,
  readGitmodules,
} from "./git.js";
import { CacheError, NoAnalysisError, UnreachableError } from "./errors.js";
import { dirname, join, liesInside, resolveRemote } from "./paths.js";
import type {
  AnalysisSource,
  Declaration,
  DeclarationSource,
  Digest,
  Entry,
  EntryKind,
  FollowedFile,
  Repository,
  SourceProvider,
  Tree,
} from "./types.js";
import type { Commit } from "../reports/types.js";

const missing = (error: unknown): boolean =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
async function digestFile(path: string): Promise<Digest> {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  let size = 0;
  try {
    const chunk = Buffer.alloc(1 << 20);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      hash.update(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    return { content_hash: `sha256:${hash.digest("hex")}`, size };
  } finally {
    await handle.close();
  }
}
async function readFile(path: string, limit?: number): Promise<Uint8Array> {
  const file = await open(path, "r");
  try {
    if (limit === undefined) return await file.readFile();
    const bytes = Buffer.alloc(limit);
    const read = await file.read(bytes, 0, limit, 0);
    return bytes.subarray(0, read.bytesRead);
  } finally {
    await file.close();
  }
}
function posix(path: string): string {
  return path.split(sep).join("/");
}
function validPath(path: string): boolean {
  return !path.startsWith("/") && join("", path) === path;
}
function noFile(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`no file at ${path}`), {
    code: "ENOENT",
    path,
  });
}

export class WorktreeTree implements Tree {
  readonly id: string;
  readonly commit = undefined;
  private readonly listed = new Map<
    string,
    Promise<Map<string, EntryKind> | undefined>
  >();
  constructor(
    readonly top: string,
    readonly repo?: Repository,
  ) {
    this.id = `worktree:${top}`;
  }
  private async entries(
    folder: string,
  ): Promise<Map<string, EntryKind> | undefined> {
    let kept = this.listed.get(folder);
    if (!kept) {
      kept = this.scan(folder);
      this.listed.set(folder, kept);
    }
    return kept;
  }
  private async scan(
    folder: string,
  ): Promise<Map<string, EntryKind> | undefined> {
    const own = folder ? await this.stat(folder) : { kind: "folder" };
    if (!own || (own.kind !== "folder" && own.kind !== "gitlink"))
      return undefined;
    const found = new Map<string, EntryKind>();
    for (const entry of await readdir(nativeJoin(this.top, folder), {
      withFileTypes: true,
    })) {
      if (entry.isSymbolicLink()) found.set(entry.name, "symlink");
      else if (entry.isDirectory())
        found.set(
          entry.name,
          (await exists(nativeJoin(this.top, folder, entry.name, ".git")))
            ? "gitlink"
            : "folder",
        );
      else if (entry.isFile()) found.set(entry.name, "file");
    }
    return found;
  }
  async stat(path: string): Promise<Entry | undefined> {
    if (path === "") return { kind: "folder" };
    if (!validPath(path)) return undefined;
    const slash = path.lastIndexOf("/");
    const parent = slash < 0 ? "" : path.slice(0, slash);
    const kind = (await this.entries(parent))?.get(path.slice(slash + 1));
    if (kind === undefined) return undefined;
    return kind === "symlink"
      ? { kind, target: await readlink(nativeJoin(this.top, path)) }
      : { kind };
  }
  async read(path: string, limit?: number): Promise<Uint8Array> {
    if ((await this.stat(path))?.kind !== "file") throw noFile(path);
    return readFile(nativeJoin(this.top, path), limit);
  }
  async digest(path: string): Promise<Digest | undefined> {
    return (await this.stat(path))?.kind === "file"
      ? digestFile(nativeJoin(this.top, path))
      : undefined;
  }
  async follow(path: string): Promise<FollowedFile | undefined> {
    try {
      const target = await realpath(nativeJoin(this.top, path));
      const info = await stat(target);
      return info.isFile()
        ? {
            path: target,
            size: info.size,
            read: (limit) => readFile(target, limit),
            digest: () => digestFile(target),
          }
        : undefined;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  private async holdingTop(folder: string): Promise<string> {
    const parts = folder ? folder.split("/") : [];
    for (let count = parts.length; count > 0; count -= 1) {
      const prefix = parts.slice(0, count).join("/");
      if ((await this.stat(prefix))?.kind === "gitlink") return prefix;
    }
    return "";
  }
  async holding(
    folder: string,
  ): Promise<{ repository: Repository; folder: string }> {
    if (!this.repo) throw new Error(`${this.top} is in no repository`);
    const inner = await this.holdingTop(folder);
    return inner
      ? {
          repository: new GitRepository(nativeJoin(this.top, inner)),
          folder: folder.slice(inner.length + 1),
        }
      : { repository: this.repo, folder };
  }
  async tracked(
    folder: string,
    paths: Iterable<string>,
  ): Promise<ReadonlySet<string>> {
    if (!this.repo) return new Set();
    const inner = await this.holdingTop(folder);
    const wanted = [...paths];
    if (!inner) return this.repo.tracked(wanted);
    const own = new Map(
      wanted
        .filter((path) => liesInside(path, inner))
        .map((path) => [path.slice(inner.length + 1), path]),
    );
    return new Set(
      [
        ...(await new GitRepository(nativeJoin(this.top, inner)).tracked(
          own.keys(),
        )),
      ].map((path) => own.get(path)!),
    );
  }
  async locate(
    path: string,
  ): Promise<{ reader: Tree; path: string } | undefined> {
    return (await this.stat(path))?.kind === "file"
      ? { reader: this, path }
      : undefined;
  }
}

type TreeEntry = { readonly mode: string; readonly oid: string };
type Found = {
  readonly reader: CommitTree;
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
};
export class CommitTree implements Tree {
  readonly id: string;
  readonly commit: Commit;
  private readonly objects = new Map<
    string,
    Promise<{ type: string; bytes: Buffer } | undefined>
  >();
  private readonly trees = new Map<
    string,
    Promise<ReadonlyMap<string, TreeEntry>>
  >();
  private readonly modules = new Map<string, Promise<CommitTree>>();
  private rootObject?: Promise<Found>;
  private urls?: Promise<ReadonlyMap<string, string>>;
  constructor(
    readonly repo: Repository,
    readonly revision: string,
    readonly provider: NodeSourceProvider,
    readonly url?: string,
  ) {
    this.id = `commit:${revision}`;
    this.commit = {
      id: revision,
      ...(url !== undefined ? { repository: url } : {}),
    };
  }
  private object(
    oid: string,
  ): Promise<{ type: string; bytes: Buffer } | undefined> {
    let kept = this.objects.get(oid);
    if (!kept) {
      kept = (async () => {
        const result = await git(
          ["-C", this.repo.top, "cat-file", "--batch"],
          Buffer.from(`${oid}\n`),
          !this.provider.offline,
        );
        const newline = result.stdout.indexOf(10);
        if (newline < 0) return undefined;
        const header = result.stdout
          .subarray(0, newline)
          .toString("ascii")
          .split(" ");
        if (header.length !== 3) return undefined;
        return {
          type: header[1]!,
          bytes: result.stdout.subarray(
            newline + 1,
            newline + 1 + Number(header[2]),
          ),
        };
      })();
      this.objects.set(oid, kept);
    }
    return kept;
  }
  private root(): Promise<Found> {
    return (this.rootObject ??= (async () => {
      const object = await this.object(this.revision);
      if (!object || object.type !== "commit")
        throw noFile(`${this.repo.top} has no commit ${this.revision}`);
      const tree = /^tree ([0-9a-f]+)/.exec(
        object.bytes.toString("ascii"),
      )?.[1];
      if (!tree) throw noFile(this.revision);
      return { reader: this, path: "", mode: "40000", oid: tree };
    })());
  }
  private tree(oid: string): Promise<ReadonlyMap<string, TreeEntry>> {
    let kept = this.trees.get(oid);
    if (!kept) {
      kept = (async () => {
        const object = await this.object(oid);
        if (!object || object.type !== "tree") throw noFile(`tree ${oid}`);
        const entries = new Map<string, TreeEntry>();
        const data = object.bytes;
        const width = oid.length / 2;
        for (let start = 0; start < data.length; ) {
          const space = data.indexOf(32, start);
          const nul = data.indexOf(0, space);
          entries.set(data.subarray(space + 1, nul).toString("utf8"), {
            mode: data.subarray(start, space).toString("ascii"),
            oid: data.subarray(nul + 1, nul + 1 + width).toString("hex"),
          });
          start = nul + 1 + width;
        }
        return entries;
      })();
      this.trees.set(oid, kept);
    }
    return kept;
  }
  private async walk(path: string, cross = true): Promise<Found | undefined> {
    if (!validPath(path)) return undefined;
    let found = await this.root();
    for (const segment of path ? path.split("/") : []) {
      if (found.mode === "160000" && cross)
        found = await found.reader.inside(found);
      if (found.mode !== "40000") return undefined;
      const entry = (await found.reader.tree(found.oid)).get(segment);
      if (!entry) return undefined;
      found = {
        reader: found.reader,
        path: found.path ? `${found.path}/${segment}` : segment,
        ...entry,
      };
    }
    return found;
  }
  private async found(path: string): Promise<Found | undefined> {
    try {
      return await this.walk(path);
    } catch (error) {
      if (error instanceof UnreachableError) return undefined;
      throw error;
    }
  }
  private async blob(
    oid: string,
    path: string,
    limit?: number,
  ): Promise<Uint8Array> {
    const bytes = await readBlob(this.repo, oid, limit, !this.provider.offline);
    if (!bytes)
      throw noFile(`${path} at ${this.revision} isn't kept in the cache`);
    return bytes;
  }
  async read(path: string, limit?: number): Promise<Uint8Array> {
    const found = await this.found(path);
    if (!found || !found.mode.startsWith("100")) throw noFile(path);
    return found.reader.blob(found.oid, path, limit);
  }
  async stat(path: string): Promise<Entry | undefined> {
    const found = await this.found(path);
    if (!found) return undefined;
    const kind =
      (
        {
          "40000": "folder",
          "160000": "gitlink",
          "120000": "symlink",
        } as Record<string, EntryKind>
      )[found.mode] ?? "file";
    return kind === "symlink"
      ? {
          kind,
          target: Buffer.from(
            await found.reader.blob(found.oid, path),
          ).toString("utf8"),
        }
      : { kind };
  }
  async digest(path: string): Promise<Digest | undefined> {
    const found = await this.found(path);
    if (!found || !found.mode.startsWith("100")) return undefined;
    const digest = await digestBlob(
      found.reader.repo,
      found.oid,
      !this.provider.offline,
    );
    if (!digest)
      throw noFile(
        `${path} at ${found.reader.revision} isn't kept in the cache`,
      );
    return digest;
  }
  async follow(_path: string): Promise<undefined> {
    return undefined;
  }
  async holding(
    folder: string,
  ): Promise<{ repository: Repository; folder: string }> {
    return { repository: this.repo, folder };
  }
  async tracked(
    _folder: string,
    paths: Iterable<string>,
  ): Promise<ReadonlySet<string>> {
    const kept = new Set<string>();
    for (const path of paths) {
      const found = await this.walk(path, false);
      if (found && /^(100|120)/.test(found.mode)) kept.add(path);
    }
    return kept;
  }
  async locate(
    path: string,
  ): Promise<{ reader: Tree; path: string } | undefined> {
    const found = await this.walk(path);
    return found?.mode.startsWith("100")
      ? { reader: found.reader, path: found.path }
      : undefined;
  }
  private async moduleUrls(): Promise<ReadonlyMap<string, string>> {
    return (this.urls ??= (async () => {
      const found = await this.walk(".gitmodules", false);
      const data = found
        ? await this.blob(found.oid, ".gitmodules")
        : new Uint8Array();
      const base = this.url ?? (await this.repo.remoteUrl()) ?? this.repo.top;
      const urls = new Map<string, string>();
      for (const [path, url] of await readGitmodules(data)) {
        const tidied = join("", path);
        if (tidied !== undefined) urls.set(tidied, resolveRemote(base, url));
      }
      return urls;
    })());
  }
  private inside(found: Found): Promise<Found> {
    let kept = this.modules.get(found.path);
    if (!kept) {
      kept = (async () => {
        const url = (await this.moduleUrls()).get(found.path);
        const folder = nativeJoin(this.repo.top, found.path);
        const local = (await exists(nativeJoin(folder, ".git")))
          ? new GitRepository(folder)
          : undefined;
        const repo = await this.provider.remote(url, found.oid, local);
        if (!repo) throw new UnreachableError(url, found.oid);
        return new CommitTree(
          repo,
          found.oid,
          this.provider,
          repo === local ? undefined : url,
        );
      })();
      this.modules.set(found.path, kept);
    }
    return kept.then((tree) => tree.root());
  }
}

export interface NodeSourceOptions {
  readonly offline?: boolean;
  readonly cacheDir?: string;
}
export class NodeSourceProvider implements SourceProvider {
  readonly offline: boolean;
  private readonly got = new Map<string, Promise<Repository | undefined>>();
  private readonly commits = new Map<string, Tree>();
  readonly cacheDir: string;
  constructor(options: NodeSourceOptions = {}) {
    this.offline = options.offline ?? false;
    const setting = options.cacheDir ?? process.env.ASTRA_CACHE_DIR;
    const configured = setting?.replace(/^~(?=\/|$)/, homedir());
    if (configured && !isAbsolute(configured))
      throw new CacheError(
        `ASTRA_CACHE_DIR is a relative path: ${configured}; give an absolute cache path`,
      );
    const normal =
      platform() === "darwin"
        ? nativeJoin(homedir(), "Library", "Caches", "astra")
        : platform() === "win32"
          ? nativeJoin(
              process.env.LOCALAPPDATA ??
                nativeJoin(homedir(), "AppData", "Local"),
              "astra",
              "cache",
            )
          : nativeJoin(
              process.env.XDG_CACHE_HOME &&
                isAbsolute(process.env.XDG_CACHE_HOME)
                ? process.env.XDG_CACHE_HOME
                : nativeJoin(homedir(), ".cache"),
              "astra",
            );
    this.cacheDir = configured || normal;
  }
  async worktree(path = process.cwd()): Promise<AnalysisSource> {
    const folder = resolve(path);
    try {
      if (!(await stat(folder)).isDirectory())
        throw new NoAnalysisError(
          `${folder} isn't a folder: give the folder of an analysis`,
        );
    } catch (error) {
      if (missing(error))
        throw new NoAnalysisError(
          `${folder} isn't a folder: give the folder of an analysis`,
        );
      throw error;
    }
    const repo = await GitRepository.discover(folder);
    const actual = await realpath(folder);
    const root = repo ? posix(relative(repo.top, actual)) : "";
    const reader = new WorktreeTree(repo?.top ?? actual, repo);
    if (
      (await reader.stat(root ? `${root}/astra.yaml` : "astra.yaml"))?.kind !==
      "file"
    ) {
      throw new NoAnalysisError(
        `${folder} has no astra.yaml file: give the folder of an analysis`,
      );
    }
    return { reader, folder: root, provider: this };
  }
  async atCommit(
    repository: Repository,
    commit: string,
    url?: string,
  ): Promise<Tree> {
    const key = JSON.stringify([repository.top, commit, url]);
    let reader = this.commits.get(key);
    if (!reader) {
      reader = new CommitTree(repository, commit, this, url);
      this.commits.set(key, reader);
    }
    return reader;
  }
  async remote(
    url: string | undefined,
    commit: string,
    local?: Repository,
  ): Promise<Repository | undefined> {
    if (local && (await local.hasCommit(commit))) return local;
    if (url === undefined) return undefined;
    const key = JSON.stringify([url, commit]);
    let kept = this.got.get(key);
    if (!kept) {
      kept = (async () => {
        const folder = nativeJoin(this.cacheDir, "remotes");
        const target = nativeJoin(
          folder,
          createHash("sha256").update(url, "utf8").digest("hex"),
        );
        try {
          if (!(await exists(target))) {
            await mkdir(folder, { recursive: true });
            const temporary = await mkdtemp(nativeJoin(folder, ".tmp-"));
            try {
              await GitRepository.initBare(
                temporary,
                url,
                commit.length === 64 ? "sha256" : "sha1",
              );
              await rename(temporary, target);
            } catch (error) {
              if (!(await exists(target))) throw error;
            } finally {
              await rm(temporary, { recursive: true, force: true });
            }
          }
          const repo = new GitRepository(target);
          const format = await repo.objectFormat();
          const required = commit.length === 64 ? "sha256" : "sha1";
          if (format !== required)
            throw new CacheError(
              `Remote cache at ${target} uses ${format}, but this commit needs ${required}; choose a new cacheDir or ASTRA_CACHE_DIR. The existing cache was left unchanged.`,
            );
          return (await repo.hasCommit(commit)) ||
            (!this.offline && (await repo.fetch(commit)))
            ? repo
            : undefined;
        } catch (error) {
          if (
            error instanceof CacheError ||
            (error instanceof Error && error.name === "GitError")
          )
            throw error;
          throw new CacheError(
            `can't use the cache at ${folder}: ${(error as Error).message}`,
            { cause: error },
          );
        }
      })();
      this.got.set(key, kept);
    }
    return kept;
  }
  async declaration(
    reader: Tree,
    folder: string,
    declaration: Declaration,
  ): Promise<DeclarationSource> {
    if (declaration.url !== undefined) {
      const repo = await this.remote(declaration.url, declaration.commit ?? "");
      if (!repo)
        return {
          outcome: "unreachable",
          url: declaration.url,
          folder: "",
          unreachable: [declaration.url, declaration.commit ?? ""],
        };
      return this.located(
        await this.atCommit(repo, declaration.commit!, declaration.url),
        "",
        declaration.url,
      );
    }
    if (declaration.commit !== undefined) {
      if (!reader.repo)
        return {
          outcome: "absent",
          folder: join(folder, declaration.path ?? ""),
        };
      const held = await reader.holding(folder);
      const inner = join(held.folder, declaration.path ?? "");
      let repository = held.repository;
      if (reader.commit?.repository !== undefined) {
        const remote = await this.remote(
          reader.commit.repository,
          declaration.commit,
        );
        if (!remote)
          return {
            outcome: "unreachable",
            folder: inner,
            url: reader.commit.repository,
            unreachable: [reader.commit.repository, declaration.commit],
          };
        repository = remote;
      } else if (!(await repository.hasCommit(declaration.commit)))
        return { outcome: "absent", folder: inner };
      if (inner === undefined) return { outcome: "outside" };
      const tree = await this.atCommit(
        repository,
        declaration.commit,
        reader.commit?.repository,
      );
      return this.located(tree, inner, reader.commit?.repository);
    }
    const path = join(folder, declaration.path ?? "");
    return path === undefined
      ? { outcome: "outside" }
      : this.located(reader, path, reader.commit?.repository);
  }
  private async located(
    reader: Tree,
    folder: string,
    url?: string,
  ): Promise<DeclarationSource> {
    const file = folder ? `${folder}/astra.yaml` : "astra.yaml";
    try {
      const found = reader.locate
        ? await reader.locate(file)
        : (await reader.stat(file))?.kind === "file"
          ? { reader, path: file }
          : undefined;
      if (!found)
        return {
          outcome: "missing",
          folder,
          ...(url !== undefined ? { url } : {}),
        };
      return {
        outcome: "reached",
        reader: found.reader,
        folder: dirname(found.path),
        ...(found.reader.commit?.repository !== undefined
          ? { url: found.reader.commit.repository }
          : {}),
      };
    } catch (error) {
      if (error instanceof UnreachableError)
        return {
          outcome: "unreachable",
          folder,
          ...(error.url !== undefined ? { url: error.url } : {}),
          unreachable: [error.url, error.commit],
        };
      throw error;
    }
  }
}

export { analysisBelow, inRepository } from "./helpers.js";
