/** Native Git access. No shell interpolation and no interactive authentication. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { Digest, Repository } from "./types.js";
import { GitError } from "./errors.js";

export interface GitResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}
export function git(
  args: readonly string[],
  input?: Uint8Array,
  lazy = false,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...(!lazy ? { GIT_NO_LAZY_FETCH: "1" } : {}),
    };
    const child = spawn("git", [...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [],
      err: Buffer[] = [];
    child.stdout.on("data", (data: Buffer) => out.push(data));
    child.stderr.on("data", (data: Buffer) => err.push(data));
    child.on("error", (error: NodeJS.ErrnoException) =>
      reject(
        new GitError(
          error.code === "ENOENT"
            ? "astra needs git, and found no `git` on PATH: install git"
            : error.message,
          { cause: error },
        ),
      ),
    );
    child.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
      }),
    );
    child.stdin.on("error", () => {}); // Git may close input after a failed command.
    child.stdin.end(input);
  });
}

export class GitRepository implements Repository {
  constructor(readonly top: string) {}
  static async discover(folder: string): Promise<GitRepository | undefined> {
    const result = await git(["-C", folder, "rev-parse", "--show-toplevel"]);
    return result.code === 0
      ? new GitRepository(result.stdout.toString("utf8").replace(/\n$/, ""))
      : undefined;
  }
  static async initBare(
    folder: string,
    url: string,
    objectFormat: "sha1" | "sha256" = "sha1",
  ): Promise<GitRepository> {
    for (const args of [
      ["init", "--quiet", "--bare", `--object-format=${objectFormat}`, folder],
      ["-C", folder, "config", "remote.origin.url", url],
    ]) {
      const result = await git(args);
      if (result.code)
        throw new GitError(
          `git can't make a repository in ${folder}: ${result.stderr.toString().trim()}`,
        );
    }
    return new GitRepository(await realpath(folder));
  }
  async objectFormat(): Promise<string> {
    const result = await git([
      "-C",
      this.top,
      "config",
      "--local",
      "--get",
      "extensions.objectFormat",
    ]);
    return result.code === 0 ? result.stdout.toString().trim() : "sha1";
  }
  async tracked(paths: Iterable<string>): Promise<ReadonlySet<string>> {
    const wanted = [...new Set(paths)].sort();
    const kept = new Set<string>();
    for (let start = 0; start < wanted.length; start += 200) {
      const result = await git([
        "-C",
        this.top,
        "ls-files",
        "--stage",
        "-z",
        "--",
        ...wanted.slice(start, start + 200).map((path) => `:(literal)${path}`),
      ]);
      if (result.code)
        throw new GitError(
          `git can't read the index of ${this.top}: ${result.stderr.toString().trim()}`,
        );
      for (const record of result.stdout.toString("utf8").split("\0")) {
        const tab = record.indexOf("\t");
        if (tab >= 0 && !record.startsWith("160000 "))
          kept.add(record.slice(tab + 1));
      }
    }
    return new Set(wanted.filter((path) => kept.has(path)));
  }
  async hasCommit(commit: string): Promise<boolean> {
    const result = await git(["-C", this.top, "cat-file", "-t", commit]);
    return result.code === 0 && result.stdout.toString() === "commit\n";
  }
  async head(): Promise<string | undefined> {
    return this.commit("HEAD");
  }
  async commit(revision: string): Promise<string | undefined> {
    const result = await git([
      "-C",
      this.top,
      "rev-parse",
      "--quiet",
      "--verify",
      "--end-of-options",
      `${revision}^{commit}`,
    ]);
    return result.code === 0
      ? result.stdout.toString().trim() || undefined
      : undefined;
  }
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return (
      (
        await git([
          "-C",
          this.top,
          "merge-base",
          "--is-ancestor",
          ancestor,
          descendant,
        ])
      ).code === 0
    );
  }
  async remoteUrl(): Promise<string | undefined> {
    const result = await git(["-C", this.top, "ls-remote", "--get-url"]);
    return result.code === 0
      ? result.stdout.toString().trim() || undefined
      : undefined;
  }
  async fetch(commit: string): Promise<boolean> {
    await git([
      "-C",
      this.top,
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--filter=blob:none",
      "origin",
      `${commit}:refs/astra/${commit}`,
    ]);
    return this.hasCommit(commit);
  }
}

export async function readGitmodules(
  data: Uint8Array,
): Promise<ReadonlyMap<string, string>> {
  const result = await git(["config", "--file", "-", "--null", "--list"], data);
  if (result.code) return new Map();
  const sections = new Map<string, Record<string, string>>();
  for (const record of result.stdout.toString("utf8").split("\0")) {
    const newline = record.indexOf("\n");
    if (newline < 0) continue;
    const key = record.slice(0, newline);
    const found = /^submodule\.(.*)\.(path|url)$/.exec(key);
    if (!found) continue;
    const section =
      sections.get(found[1]!) ??
      (Object.create(null) as Record<string, string>);
    section[found[2]!] = record.slice(newline + 1);
    sections.set(found[1]!, section);
  }
  return new Map(
    [...sections.values()]
      .filter((value) => value.path !== undefined && value.url !== undefined)
      .map((value) => [value.path!, value.url!]),
  );
}

/** Read a blob without retaining bytes beyond the requested prefix. */
export function readBlob(
  repo: Repository,
  oid: string,
  limit?: number,
  lazy = false,
): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repo.top, "cat-file", "blob", oid], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        ...(!lazy ? { GIT_NO_LAZY_FETCH: "1" } : {}),
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let held = 0;
    let truncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      const keep =
        limit === undefined
          ? chunk
          : chunk.subarray(0, Math.max(0, limit - held));
      if (keep.length) {
        chunks.push(keep);
        held += keep.length;
      }
      if (limit !== undefined && held >= limit && !truncated) {
        truncated = true;
        child.kill();
      }
    });
    child.on("error", (error) =>
      reject(new GitError(error.message, { cause: error })),
    );
    child.on("close", (code) =>
      resolve(code === 0 || truncated ? Buffer.concat(chunks) : undefined),
    );
  });
}

/** Hash historical content incrementally rather than loading scientific data into memory. */
export function digestBlob(
  repo: Repository,
  oid: string,
  lazy = false,
): Promise<Digest | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repo.top, "cat-file", "blob", oid], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        ...(!lazy ? { GIT_NO_LAZY_FETCH: "1" } : {}),
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const hash = createHash("sha256");
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      size += chunk.length;
    });
    child.on("error", (error) =>
      reject(new GitError(error.message, { cause: error })),
    );
    child.on("close", (code) =>
      resolve(
        code === 0
          ? { content_hash: `sha256:${hash.digest("hex")}`, size }
          : undefined,
      ),
    );
  });
}

/** Stream a historical blob, terminating Git when the consumer stops early. */
export async function* streamBlob(
  repo: Repository,
  oid: string,
  lazy = false,
): AsyncGenerator<Uint8Array> {
  const child = spawn("git", ["-C", repo.top, "cat-file", "blob", oid], {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...(!lazy ? { GIT_NO_LAZY_FETCH: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "ignore"],
  });
  // Resolve errors as values so an early process error cannot become an unhandled rejection.
  const finished = new Promise<number | Error>((resolve) => {
    child.on("error", resolve);
    child.on("close", (code) => resolve(code ?? 1));
  });
  try {
    for await (const chunk of child.stdout) yield chunk as Buffer;
    const code = await finished;
    if (code !== 0)
      throw new GitError(`git can't read blob ${oid}`, {
        ...(code instanceof Error ? { cause: code } : {}),
      });
  } finally {
    if (child.exitCode === null) child.kill();
    await finished;
  }
}
