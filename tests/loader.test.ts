import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ASTRA_SPEC_VERSION,
  astraSchemaUrl,
  clearAstraSchemaCache,
  loadAstraSchema,
  setAstraSchema,
} from "../src/schema/index.js";

beforeEach(() => clearAstraSchemaCache());
afterEach(() => vi.restoreAllMocks());

describe("astraSchemaUrl", () => {
  it("defaults to the schema version supported by the SDK", () => {
    expect(ASTRA_SPEC_VERSION).toBe("0.0.14");
    expect(astraSchemaUrl()).toBe(
      "https://astra-spec.org/0.0.14/schema/astra.schema.json",
    );
  });

  it("builds versioned URLs", () => {
    expect(astraSchemaUrl("0.0.10")).toBe("https://astra-spec.org/0.0.10/schema/astra.schema.json");
  });
});

describe("loadAstraSchema", () => {
  it("loads the supported schema offline by default", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const schema = await loadAstraSchema();
    expect(schema.version).toBe(ASTRA_SPEC_VERSION);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not expose a mutable bundled schema singleton", async () => {
    const schema = await loadAstraSchema();
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.$defs)).toBe(true);
    expect(() => {
      schema.version = "poisoned";
    }).toThrow(TypeError);

    clearAstraSchemaCache();
    expect((await loadAstraSchema()).version).toBe(ASTRA_SPEC_VERSION);
  });

  it("loads from a fetchable URL without Node filesystem APIs", async () => {
    const body = JSON.stringify({ $defs: { Analysis: {}, Universe: {} } });
    const url = `data:application/json,${encodeURIComponent(body)}`;
    const schema = await loadAstraSchema({ url });
    expect(schema).toHaveProperty("$defs");
    expect((schema as { $defs: Record<string, unknown> }).$defs).toHaveProperty("Analysis");
  });

  it("reuses its browser-safe in-memory cache", async () => {
    const url = `data:application/json,${encodeURIComponent(JSON.stringify({ title: "schema" }))}`;
    const first = await loadAstraSchema({ url });
    const second = await loadAstraSchema({ url });
    expect(second).toBe(first);
  });
});

describe("setAstraSchema", () => {
  it("makes a pre-loaded schema available without fetching", async () => {
    const stub = { $defs: { Analysis: {}, Universe: {} } } as Record<string, unknown>;
    setAstraSchema(stub);
    const loaded = await loadAstraSchema();
    expect(loaded).toBe(stub);
  });

  it("retains a default override when force has no remote source", async () => {
    const stub = { $defs: { Analysis: {}, Universe: {} } } as Record<string, unknown>;
    setAstraSchema(stub);
    expect(await loadAstraSchema({ force: true })).toBe(stub);
  });
});
