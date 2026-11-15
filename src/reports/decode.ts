/** Decode the public Python JSON reports without project I/O or semantic resolution. */

import Ajv2019 from "ajv/dist/2019.js";
import type { ErrorObject, ValidateFunction } from "ajv";

import { reportSchema } from "./schema.js";
import type { ResolvedAnalysis, StatusReport, ValidationReport } from "./types.js";

type ReportName = "ResolvedAnalysis" | "ValidationReport" | "StatusReport";

export type ReportValidationIssueCode =
  | "INVALID_JSON"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | `SCHEMA_${string}`;

/** A structural issue; paths are JSON Pointers, with an empty string for the root. */
export interface ReportValidationIssue {
  readonly code: ReportValidationIssueCode;
  readonly path: string;
  readonly message: string;
}

export class ReportValidationError extends Error {
  readonly report: ReportName;
  readonly issues: readonly ReportValidationIssue[];

  constructor(report: ReportName, issues: readonly ReportValidationIssue[]) {
    const first = issues[0];
    super(`Invalid ${report}${first ? ` at ${first.path || "<root>"}: ${first.message}` : ""}`);
    this.name = "ReportValidationError";
    this.report = report;
    this.issues = [...issues];
  }
}

interface Validators {
  ResolvedAnalysis: ValidateFunction<ResolvedAnalysis>;
  ValidationReport: ValidateFunction<ValidationReport>;
  StatusReport: ValidateFunction<StatusReport>;
}

let compiled: Validators | undefined;

function validators(): Validators {
  if (compiled) return compiled;
  const ajv = new Ajv2019({ allErrors: true, strict: true, ownProperties: true });
  ajv.addSchema(reportSchema);
  const id = reportSchema.$id;
  compiled = {
    ResolvedAnalysis: ajv.getSchema<ResolvedAnalysis>(`${id}#/$defs/ResolvedAnalysis`)!,
    ValidationReport: ajv.getSchema<ValidationReport>(`${id}#/$defs/ValidationReport`)!,
    StatusReport: ajv.getSchema<StatusReport>(`${id}#/$defs/StatusReport`)!,
  };
  return compiled;
}

function childPath(path: string, key: string): string {
  return `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

/** Include unknown fields in the JSON check, while retaining them unchanged. */
function jsonIssue(candidate: unknown): ReportValidationIssue | undefined {
  const pending = [{ value: candidate, path: "", exit: false }];
  const ancestors = new Set<object>();
  while (pending.length) {
    const { value, path, exit } = pending.pop()!;
    if (exit) {
      ancestors.delete(value as object);
      continue;
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number" && Number.isFinite(value)) continue;
    if (typeof value !== "object") {
      return { code: "INVALID_JSON", path, message: "Expected a JSON value" };
    }
    if (ancestors.has(value)) {
      return { code: "INVALID_JSON", path, message: "Cyclic objects are not JSON" };
    }
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) {
      return { code: "INVALID_JSON", path, message: "Expected a plain JSON object" };
    }
    ancestors.add(value);
    pending.push({ value, path, exit: true });
    if (array) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: value[index], path: childPath(path, String(index)), exit: false });
      }
    } else {
      const entries = Object.entries(value);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index]!;
        pending.push({ value: child, path: childPath(path, key), exit: false });
      }
    }
  }
  return undefined;
}

function schemaIssue(error: ErrorObject): ReportValidationIssue {
  const path = error.keyword === "required"
    ? childPath(error.instancePath, (error.params as { missingProperty: string }).missingProperty)
    : error.instancePath;
  return {
    code: error.keyword === "const" && path === "/schema_version"
      ? "UNSUPPORTED_SCHEMA_VERSION"
      : `SCHEMA_${error.keyword.toUpperCase()}`,
    path,
    message: error.message ?? "Report schema validation failed",
  };
}

function parse<T>(candidate: unknown, report: ReportName, validate: ValidateFunction<T>): T {
  const issue = jsonIssue(candidate);
  if (issue) throw new ReportValidationError(report, [issue]);
  if (!validate(candidate)) {
    throw new ReportValidationError(report, (validate.errors ?? []).map(schemaIssue));
  }
  return candidate;
}

/** Accept an already-deserialized report and return it unchanged. */
export function parseResolvedAnalysis(candidate: unknown): ResolvedAnalysis {
  return parse(candidate, "ResolvedAnalysis", validators().ResolvedAnalysis);
}

/** Accept an already-deserialized report and return it unchanged. */
export function parseValidationReport(candidate: unknown): ValidationReport {
  return parse(candidate, "ValidationReport", validators().ValidationReport);
}

/** Accept an already-deserialized report and return it unchanged. */
export function parseStatusReport(candidate: unknown): StatusReport {
  return parse(candidate, "StatusReport", validators().StatusReport);
}

export function isResolvedAnalysis(candidate: unknown): candidate is ResolvedAnalysis {
  return !jsonIssue(candidate) && validators().ResolvedAnalysis(candidate);
}

export function isValidationReport(candidate: unknown): candidate is ValidationReport {
  return !jsonIssue(candidate) && validators().ValidationReport(candidate);
}

export function isStatusReport(candidate: unknown): candidate is StatusReport {
  return !jsonIssue(candidate) && validators().StatusReport(candidate);
}
