import { describe, expect, it, beforeEach } from "vitest";

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
    setAstraSchema(stub, { version: "latest" });
    const loaded = await loadAstraSchema(); // no url, no version → "latest"
    expect(loaded).toBe(stub);
  });
});
