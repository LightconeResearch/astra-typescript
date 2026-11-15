import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isResolvedAnalysis,
  isStatusReport,
  isValidationReport,
  parseResolvedAnalysis,
  parseStatusReport,
  parseValidationReport,
  ReportValidationError,
  RESOLVED_ANALYSIS_SCHEMA_VERSION,
  STATUS_REPORT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
} from "../src/reports/index.js";

type JsonObject = Record<string, unknown>;

function fixture(operation: string, name = "driven"): JsonObject {
  const path = resolve("vendor/astra-tools/report-fixtures", name, `${operation}.json`);
  return JSON.parse(readFileSync(path, "utf-8")) as JsonObject;
}

const reports = [
  {
    operation: "resolve",
    parse: parseResolvedAnalysis,
    guard: isResolvedAnalysis,
    collection: "analyses",
    version: RESOLVED_ANALYSIS_SCHEMA_VERSION,
  },
  {
    operation: "validate",
    parse: parseValidationReport,
    guard: isValidationReport,
    collection: "diagnostics",
    version: VALIDATION_REPORT_SCHEMA_VERSION,
  },
  {
    operation: "status",
    parse: parseStatusReport,
    guard: isStatusReport,
    collection: "statuses",
    version: STATUS_REPORT_SCHEMA_VERSION,
  },
] as const;

function issues(action: () => unknown) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ReportValidationError);
    return (error as ReportValidationError).issues;
  }
  throw new Error("Expected the report to fail decoding");
}

describe.each(reports)("$operation report transport", (report) => {
  it.each(["driven", "switch-status"])("accepts the unchanged Python %s golden", (name) => {
    const candidate = fixture(report.operation, name);
    const before = JSON.stringify(candidate);
    expect(report.parse(candidate)).toBe(candidate);
    expect(report.guard(candidate)).toBe(true);
    expect(candidate.schema_version).toBe(report.version);
    expect(JSON.stringify(candidate)).toBe(before);
  });

  it("retains unknown JSON fields without injecting omitted fields", () => {
    const candidate = fixture(report.operation);
    const extra = { value: null, nested: [1, "two", false] };
    candidate.future_field = extra;
    delete candidate.head;
    const before = JSON.stringify(candidate);
    expect(report.parse(candidate)).toBe(candidate);
    expect(candidate.future_field).toBe(extra);
    expect(JSON.stringify(candidate)).toBe(before);
  });

  it("requires the report's version marker", () => {
    const candidate = fixture(report.operation);
    delete candidate.schema_version;
    expect(report.guard(candidate)).toBe(false);
    expect(issues(() => report.parse(candidate))).toContainEqual(expect.objectContaining({
      code: "SCHEMA_REQUIRED",
      path: "/schema_version",
      message: expect.any(String),
    }));
    candidate.schema_version = "unknown.v1";
    expect(issues(() => report.parse(candidate))).toContainEqual(expect.objectContaining({
      code: "UNSUPPORTED_SCHEMA_VERSION",
      path: "/schema_version",
      message: expect.any(String),
    }));
  });

  it("rejects missing and null required collections", () => {
    const candidate = fixture(report.operation);
    delete candidate[report.collection];
    expect(issues(() => report.parse(candidate))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_REQUIRED", path: `/${report.collection}` }),
    ]));
    candidate[report.collection] = null;
    expect(report.guard(candidate)).toBe(false);
    expect(issues(() => report.parse(candidate))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_TYPE", path: `/${report.collection}` }),
    ]));
  });

  it("rejects the other report kinds", () => {
    for (const other of reports) {
      if (other.operation === report.operation) continue;
      expect(report.guard(fixture(other.operation))).toBe(false);
      expect(() => report.parse(fixture(other.operation))).toThrow(ReportValidationError);
    }
  });
});

describe("report decoder diagnostics", () => {
  it("checks optional fields when present and does not coerce types", () => {
    const candidate = fixture("resolve");
    candidate.head = null;
    expect(issues(() => parseResolvedAnalysis(candidate))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_TYPE", path: "/head" }),
    ]));
    const validation = fixture("validate");
    validation.valid = "true";
    expect(isValidationReport(validation)).toBe(false);
    expect(validation.valid).toBe("true");
  });

  it("reports nested JSON Pointers and preserves earlier diagnostics", () => {
    const candidate = fixture("resolve");
    const first = (candidate.analyses as JsonObject[])[0]!;
    first.folder = 7;
    const previous = issues(() => parseResolvedAnalysis(candidate));
    expect(previous).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_TYPE", path: "/analyses/0/folder" }),
    ]));
    const before = JSON.stringify(previous);
    expect(isResolvedAnalysis(fixture("resolve"))).toBe(true);
    issues(() => parseResolvedAnalysis({}));
    expect(JSON.stringify(previous)).toBe(before);
  });

  it.each([undefined, NaN, Infinity, 1n, new Date("2026-01-01"), () => "value"])(
    "rejects non-JSON extra values (%s)",
    (value) => {
      const candidate = fixture("validate");
      candidate.future_field = value;
      expect(isValidationReport(candidate)).toBe(false);
      expect(issues(() => parseValidationReport(candidate))).toEqual([
        expect.objectContaining({ code: "INVALID_JSON", path: "/future_field" }),
      ]);
    },
  );

  it("escapes JSON Pointer segments in extra fields", () => {
    const candidate = fixture("validate");
    candidate["future/~field"] = NaN;
    expect(issues(() => parseValidationReport(candidate))).toEqual([
      expect.objectContaining({ code: "INVALID_JSON", path: "/future~1~0field" }),
    ]);
  });

  it("rejects cycles while allowing repeated references to a JSON value", () => {
    const candidate = fixture("validate");
    candidate.future_field = candidate;
    expect(isValidationReport(candidate)).toBe(false);
    expect(issues(() => parseValidationReport(candidate))).toEqual([
      expect.objectContaining({ code: "INVALID_JSON", path: "/future_field" }),
    ]);
    const shared = { value: 1 };
    candidate.future_field = [shared, shared];
    expect(parseValidationReport(candidate)).toBe(candidate);
  });

  it("does not accept inherited fields as report properties", () => {
    const inherited = Object.create(fixture("validate")) as unknown;
    expect(isValidationReport(inherited)).toBe(false);
    expect(() => parseValidationReport(inherited)).toThrow(ReportValidationError);
    const plain = Object.assign(Object.create(null), fixture("validate")) as unknown;
    expect(isValidationReport(plain)).toBe(true);
  });
});
