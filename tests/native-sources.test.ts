import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitRepository } from "../src/sources/git.js";
import { NodeSourceProvider } from "../src/sources/node.js";
import { content, digestBytes, look } from "../src/sources/standins.js";
import { join as sourceJoin, resolveRemote } from "../src/sources/paths.js";

let place: string;
beforeEach(async () => {
  place = await mkdtemp(join(tmpdir(), "astra-native-source-"));
});
afterEach(async () => {
  await rm(place, { recursive: true, force: true });
});
function git(folder: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Source tests",
      "-c",
      "user.email=sources@astra.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "protocol.file.allow=always",
      "-C",
      folder,
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
}
async function repository(
  name = "work",
  objectFormat?: "sha1" | "sha256",
): Promise<string> {
  const folder = join(place, name);
  await mkdir(folder);
  git(
    folder,
    "init",
    "--quiet",
    ...(objectFormat ? [`--object-format=${objectFormat}`] : []),
  );
  await writeFile(join(folder, "astra.yaml"), "spec_version: '0.1.0'\n");
  return folder;
}
async function commit(folder: string): Promise<string> {
  git(folder, "add", "--all");
  git(folder, "commit", "--quiet", "--message", "files");
  return git(folder, "rev-parse", "HEAD");
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("repository source trees", () => {
  it("reads exact worktree names, refuses ordinary symlinks and follows parent declarations", async () => {
    const folder = await repository();
    await mkdir(join(folder, "stage"));
    await writeFile(
      join(folder, "stage/astra.yaml"),
      "spec_version: '0.1.0'\n",
    );
    await writeFile(join(folder, "Data.csv"), "data\n");
    await symlink("Data.csv", join(folder, "alias.csv"));
    await symlink("stage", join(folder, "alias-stage"));
    await commit(folder);
    const provider = new NodeSourceProvider({ cacheDir: join(place, "cache") });
    const { reader, folder: inner } = await provider.worktree(
      join(folder, "stage"),
    );
    expect(inner).toBe("stage");
    expect((await reader.stat("Data.csv"))?.kind).toBe("file");
    expect(await reader.stat("data.csv")).toBeUndefined();
    expect(await reader.stat("alias-stage/astra.yaml")).toBeUndefined();
    expect((await reader.stat("alias.csv"))?.kind).toBe("symlink");
    await expect(reader.read("alias.csv")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await provider.declaration(reader, "stage", { path: ".." }),
    ).toMatchObject({ outcome: "reached", folder: "" });
    expect(
      await provider.declaration(reader, "", { path: ".." }),
    ).toMatchObject({ outcome: "outside" });
    expect(
      await reader.tracked("", ["Data.csv", "alias.csv", "missing"]),
    ).toEqual(new Set(["Data.csv", "alias.csv"]));
  });

  it("reads historical blobs and case-sensitive paths without checking out", async () => {
    const folder = await repository();
    await writeFile(join(folder, "input.txt"), "old\n");
    const head = await commit(folder);
    await writeFile(join(folder, "input.txt"), "new\n");
    const provider = new NodeSourceProvider();
    const root = await provider.worktree(folder);
    const tree = await provider.atCommit(root.reader.repo!, head);
    expect(text(await tree.read("input.txt"))).toBe("old\n");
    expect(text(await root.reader.read("input.txt"))).toBe("new\n");
    expect(await tree.stat("INPUT.txt")).toBeUndefined();
    expect(await tree.follow("input.txt")).toBeUndefined();
    expect(await tree.tracked("", ["input.txt", "missing"])).toEqual(
      new Set(["input.txt"]),
    );
    expect(
      await provider.declaration(root.reader, "", { path: ".", commit: head }),
    ).toMatchObject({
      outcome: "reached",
      folder: "",
      reader: { commit: { id: head } },
    });
    expect(
      await provider.declaration(root.reader, "", {
        path: ".",
        commit: "a".repeat(40),
      }),
    ).toMatchObject({ outcome: "absent" });
  });

  it("fetches a remote into its cache and reuses it offline", async () => {
    const remote = await repository("remote");
    await writeFile(join(remote, "input.txt"), "remote\n");
    const head = await commit(remote);
    const cacheDir = join(place, "cache");
    const online = new NodeSourceProvider({ cacheDir });
    const found = await online.remote(remote, head);
    expect(found?.top).not.toBe(remote);
    const tree = await online.atCommit(found!, head, remote);
    expect(text(await tree.read("input.txt"))).toBe("remote\n");
    const offline = new NodeSourceProvider({ offline: true, cacheDir });
    expect(await offline.remote(remote, head)).toBeDefined();
    expect(await offline.remote(remote, "a".repeat(40))).toBeUndefined();
  });

  it("reads SHA-256 local trees and initializes matching remote caches, including offline reuse", async () => {
    const remote = await repository("sha256", "sha256");
    await writeFile(join(remote, "data.txt"), "SHA-256 content\n");
    const head = await commit(remote);
    expect(head).toHaveLength(64);
    const cacheDir = join(place, "sha256-cache");
    const provider = new NodeSourceProvider({ cacheDir });
    const source = await provider.worktree(remote);
    const local = await provider.atCommit(source.reader.repo!, head);
    expect(text(await local.read("data.txt"))).toBe("SHA-256 content\n");
    const stored = await provider.remote(remote, head);
    expect(stored).toBeDefined();
    expect(await new GitRepository(stored!.top).objectFormat()).toBe("sha256");
    const cached = await provider.atCommit(stored!, head, remote);
    expect(text(await cached.read("data.txt"))).toBe("SHA-256 content\n");
    expect(await cached.digest!("data.txt")).toEqual(
      await digestBytes(new TextEncoder().encode("SHA-256 content\n")),
    );
    const offline = new NodeSourceProvider({ offline: true, cacheDir });
    expect(await offline.remote(remote, head)).toBeDefined();
  });

  it("leaves a cache with a different object format intact and requests a new cache location", async () => {
    const remote = await repository("sha256", "sha256");
    const head = await commit(remote);
    const provider = new NodeSourceProvider({
      cacheDir: join(place, "wrong-format"),
    });
    expect(await provider.remote(remote, "a".repeat(40))).toBeUndefined();
    const directory = join(
      place,
      "wrong-format/remotes",
      (await readdir(join(place, "wrong-format/remotes")))[0]!,
    );
    const config = await readFile(join(directory, "config"), "utf8");
    await expect(provider.remote(remote, head)).rejects.toMatchObject({
      name: "CacheError",
      message: expect.stringContaining(
        "choose a new cacheDir or ASTRA_CACHE_DIR",
      ),
    });
    await expect(provider.remote(remote, head)).rejects.toMatchObject({
      name: "CacheError",
    });
    expect(await readFile(join(directory, "config"), "utf8")).toBe(config);
    expect(await new GitRepository(directory).objectFormat()).toBe("sha1");
  });

  it("crosses committed gitlinks at their pinned tree and keeps tracking in its own repository", async () => {
    const child = await repository("child");
    await writeFile(join(child, "data.txt"), "child\n");
    const childHead = await commit(child);
    const parent = await repository("parent");
    git(parent, "submodule", "add", "--quiet", child, "child");
    const head = await commit(parent);
    const provider = new NodeSourceProvider({ cacheDir: join(place, "cache") });
    const source = await provider.worktree(parent);
    const tree = await provider.atCommit(source.reader.repo!, head);
    expect(text(await tree.read("child/data.txt"))).toBe("child\n");
    expect(await tree.tracked("", ["child/data.txt", "child"])).toEqual(
      new Set(),
    );
    const located = await tree.locate!("child/astra.yaml");
    expect(located?.reader.commit?.id).toBe(childHead);
    expect(located?.path).toBe("astra.yaml");
    const declared = await provider.declaration(tree, "", { path: "child" });
    expect(declared).toMatchObject({
      outcome: "reached",
      folder: "",
      reader: { commit: { id: childHead } },
    });
    expect(await source.reader.tracked("child", ["child/data.txt"])).toEqual(
      new Set(["child/data.txt"]),
    );
  });
});

describe("stand-ins and content identities", () => {
  it("keeps Git LFS pointer bytes separate from its absent content", async () => {
    const folder = await repository();
    const expected = await digestBytes(new TextEncoder().encode("content\n"));
    await writeFile(
      join(folder, "data.txt"),
      `version https://git-lfs.github.com/spec/v1\noid ${expected.content_hash}\nsize ${expected.size}\n`,
    );
    const { reader } = await new NodeSourceProvider().worktree(folder);
    const found = await look(reader, "data.txt");
    expect(found).toMatchObject({ here: false, kept_by: "Git LFS" });
    expect(await content(reader, "data.txt", found)).toEqual(expected);
  });

  it("reads git-annex content only where its resolved link is really in annex/objects", async () => {
    const folder = await repository();
    const bytes = new TextEncoder().encode("annex\n");
    const expected = await digestBytes(bytes);
    const key = `SHA256E-s${expected.size}--${expected.content_hash.slice(7)}.txt`;
    const target = `.git/annex/objects/a/b/${key}/${key}`;
    await mkdir(join(folder, target, ".."), { recursive: true });
    await writeFile(join(folder, target), bytes);
    await symlink(target, join(folder, "data.txt"));
    const { reader } = await new NodeSourceProvider().worktree(folder);
    const found = await look(reader, "data.txt");
    expect(found).toMatchObject({ here: true, kept_by: "git-annex" });
    expect(await content(reader, "data.txt", found)).toEqual(expected);
    await rm(join(folder, target));
    expect(await look(reader, "data.txt")).toMatchObject({
      here: false,
      kept_by: "git-annex",
    });
  });

  it("allows fetched DVC content through its cache link and supplies no hash until fetched", async () => {
    const folder = await repository();
    await writeFile(join(folder, "data.txt.dvc"), "outs: []\n");
    const provider = new NodeSourceProvider();
    let { reader } = await provider.worktree(folder);
    const absent = await look(reader, "data.txt");
    expect(absent).toMatchObject({ here: false, kept_by: "DVC" });
    expect(await content(reader, "data.txt", absent)).toBeUndefined();
    const cache = join(place, "external-content");
    await writeFile(cache, "DVC\n");
    await symlink(cache, join(folder, "data.txt"));
    ({ reader } = await provider.worktree(folder));
    const found = await look(reader, "data.txt");
    expect(found.here).toBe(true);
    expect(await content(reader, "data.txt", found)).toEqual(
      await digestBytes(await readFile(cache)),
    );
  });

  it("does not read ordinary long content in full to recognise pointers", async () => {
    let readLimit: number | undefined;
    const reader = {
      stat: async () => ({ kind: "file" as const }),
      read: async (_path: string, limit?: number) => {
        readLimit = limit;
        return new Uint8Array(limit ?? 1_000_000);
      },
      follow: async () => undefined,
    } as unknown as import("../src/sources/types.js").Tree;
    const found = await look(reader, "large.bin");
    // DVC's existence is stubbed too, so only its sidecar is recognised.
    expect(found.kept_by).toBe("DVC");
    expect(readLimit).toBe(1025);
  });

  it("normalizes lexical paths and relative Git URLs", () => {
    expect(sourceJoin("stage", "../data/file")).toBe("data/file");
    expect(sourceJoin("", "../data")).toBeUndefined();
    expect(
      resolveRemote("git@example.org:group/main.git", "../child.git"),
    ).toBe("git@example.org:group/child.git");
    expect(
      resolveRemote("https://example.org/group/main.git", "../child.git"),
    ).toBe("https://example.org/group/child.git");
  });
});
