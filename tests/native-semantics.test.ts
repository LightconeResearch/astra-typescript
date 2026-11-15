import { readFileSync } from "node:fs";
import { join, resolve as path } from "node:path";
import { expect, it } from "vitest";
import { NodeSourceProvider } from "../src/sources/node.js";
import { bind } from "../src/engine/stack.js";
import { Context } from "../src/engine/universes.js";
import { resolve } from "../src/engine/resolve.js";
import { buildCase } from "./native-case.js";
const fixtures = path("upstream/astra-tools/tests/report-fixtures");
const manifest = JSON.parse(
  readFileSync(join(fixtures, "manifest.json"), "utf8"),
);
it.each(manifest.cases as string[])(
  "native semantic report matches Python: %s",
  async (name) => {
    const place = await buildCase(
      join(fixtures, name),
      manifest.git_environment,
    );
    try {
      const provider = new NodeSourceProvider({
        offline: true,
        cacheDir: join(place.place, "cache"),
      });
      const source = await provider.worktree(place.work);
      const bound = await bind(source.reader, source.folder, provider);
      expect(bound.diagnostics).toEqual([]);
      expect(bound.stack).toBeDefined();
      const actual = await resolve(new Context(bound.stack!));
      expect(actual.analysis).toEqual(
        JSON.parse(readFileSync(join(fixtures, name, "resolve.json"), "utf8")),
      );
    } finally {
      await place.dispose();
    }
  },
);
