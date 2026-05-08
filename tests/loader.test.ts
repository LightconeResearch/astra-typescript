import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  astraSchemaUrl,
  clearAstraSchemaCache,
  loadAstraSchema,
  setAstraSchema,
} from "../src/schema/index.js";

beforeEach(() => clearAstraSchemaCache());

describe("astraSchemaUrl", () => {
  it("defaults to /latest/ on astra-spec.org", () => {
    expect(astraSchemaUrl()).toBe("https://astra-spec.org/latest/schema/astra.schema.json");
  });

  it("builds versioned URLs", () => {
    expect(astraSchemaUrl("0.0.10")).toBe("https://astra-spec.org/0.0.10/schema/astra.schema.json");
  });
});

describe("loadAstraSchema", () => {
  it("loads from a file:// URL", async () => {
    // Write a minimal schema stub to a temp file and load it. This
    // exercises the file:// branch without requiring any external fetch.
    const dir = mkdtempSync(join(tmpdir(), "astra-schema-stub-"));
    const path = join(dir, "schema.json");
    writeFileSync(path, JSON.stringify({ $defs: { Analysis: {}, Universe: {} } }));
    const url = pathToFileURL(path).href;

    const schema = await loadAstraSchema({ url, cacheDir: false });
    expect(schema).toHaveProperty("$defs");
    expect((schema as { $defs: Record<string, unknown> }).$defs).toHaveProperty("Analysis");
  });

  it("writes a disk cache entry and reuses it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astra-schema-stub-"));
    const path = join(dir, "schema.json");
    writeFileSync(path, JSON.stringify({ $defs: { Analysis: {}, Universe: {} } }));
    const url = pathToFileURL(path).href;

    const cacheDir = mkdtempSync(join(tmpdir(), "astra-schema-cache-test-"));
    await loadAstraSchema({ url, cacheDir });
    expect(existsSync(cacheDir)).toBe(true);
    expect(readdirSync(cacheDir).length).toBe(1);

    // After clearing the in-memory cache, a second call still succeeds
    // because the disk cache satisfies it.
    clearAstraSchemaCache();
    const schema = await loadAstraSchema({ url, cacheDir });
    expect(schema).toHaveProperty("$defs");
  });
});

describe("setAstraSchema", () => {
  it("makes a pre-loaded schema available without fetching", async () => {
    const stub = { $defs: { Analysis: {}, Universe: {} } } as Record<string, unknown>;
    setAstraSchema(stub, { version: "latest" });
    const loaded = await loadAstraSchema(); // no url, no version → "latest"
    expect(loaded).toBe(stub);
  });
});
