import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Build the specification's portable Git repositories without executing recipes. */
export async function buildCase(
  path: string,
  extra: Record<string, string> = {},
) {
  const place = await mkdtemp(join(tmpdir(), "astra-native-case-"));
  const work = join(place, "work");
  await Promise.all([
    mkdir(join(place, "home")),
    mkdir(join(place, "remotes")),
  ]);
  await cp(join(path, "files"), work, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const environment = {
    PATH: process.env.PATH!,
    HOME: join(place, "home"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "ASTRA conformance",
    GIT_COMMITTER_NAME: "ASTRA conformance",
    GIT_AUTHOR_EMAIL: "conformance@astra.invalid",
    GIT_COMMITTER_EMAIL: "conformance@astra.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    GIT_CEILING_DIRECTORIES: place,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "protocol.file.allow",
    GIT_CONFIG_VALUE_0: "always",
    ASTRA_CASE_REMOTES: join(place, "remotes"),
    ...extra,
  };
  try {
    const setup = join(resolve(path), "setup.sh");
    if (existsSync(setup))
      execFileSync("sh", ["-eu", setup], {
        cwd: work,
        env: environment,
        stdio: "pipe",
      });
    else
      for (const args of [
        ["init"],
        ["add", "--all"],
        ["commit", "--message", "files"],
      ]) {
        execFileSync("git", args, {
          cwd: work,
          env: environment,
          stdio: "pipe",
        });
      }
    return {
      work,
      place,
      dispose: () => rm(place, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(place, { recursive: true, force: true });
    throw error;
  }
}
