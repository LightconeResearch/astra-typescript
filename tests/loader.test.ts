import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  astraSchemaUrl,
  clearAstraSchemaCache,
  loadAstraSchema,
  setAstraSchema,
} from "../src/schema/index.js";
import { SPEC_PATHS } from "./setup.js";

const localUrl = pathToFileURL(SPEC_PATHS.schema).href;

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
    const schema = await loadAstraSchema({ url: localUrl, cacheDir: false });
    expect(schema).toHaveProperty("$defs");
    expect((schema as { $defs: Record<string, unknown> }).$defs).toHaveProperty("Analysis");
  });

  it("writes a disk cache entry and reuses it", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "astra-schema-cache-test-"));
    await loadAstraSchema({ url: localUrl, cacheDir });
    expect(existsSync(cacheDir)).toBe(true);
    expect(readdirSync(cacheDir).length).toBe(1);

    // Second call should still succeed even with the network unavailable
    // because we hit the disk cache (we simulate by clearing memory only).
    clearAstraSchemaCache();
    const schema = await loadAstraSchema({ url: localUrl, cacheDir });
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
