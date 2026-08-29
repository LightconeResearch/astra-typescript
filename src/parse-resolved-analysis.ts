/**
 * Runtime decoding for resolved bundles that crossed a serialization boundary.
 *
 * `ResolvedAnalysisBundle` is a TypeScript contract, so its guarantees disappear
 * when a bundle is read from JSON, structured-clone storage, a message channel,
 * or a remote API. The helpers in this module restore that type guarantee
 * without reopening a project or repeating ASTRA's semantic resolution.
 */

import {
  RESOLVED_ANALYSIS_SCHEMA_VERSION,
  type ResolvedAnalysisBundle,
} from "./resolved-types.js";

type UnknownRecord = Record<string, unknown>;

export type ResolvedAnalysisBundleValidationIssueCode =
  | "MISSING_PROPERTY"
  | "INVALID_TYPE"
  | "INVALID_VALUE"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "CYCLIC_ANALYSIS";

/** One structural problem found while decoding a serialized resolved bundle. */
export interface ResolvedAnalysisBundleValidationIssue {
  readonly code: ResolvedAnalysisBundleValidationIssueCode;
  /** JavaScript-style path rooted at `$`, for example `$.document.analysis.outputs[0].active`. */
  readonly path: string;
  readonly message: string;
}

/** Raised when unknown transport data is not a current resolved bundle. */
export class ResolvedAnalysisBundleValidationError extends Error {
  readonly issues: readonly ResolvedAnalysisBundleValidationIssue[];

  constructor(issues: readonly ResolvedAnalysisBundleValidationIssue[]) {
    const first = issues[0];
    super(
      first
        ? `Invalid resolved analysis bundle at ${first.path}: ${first.message}`
        : "Invalid resolved analysis bundle",
    );
    this.name = "ResolvedAnalysisBundleValidationError";
    this.issues = [...issues];
  }
}

const ABSENT = Symbol("absent property");
const INPUT_TYPES = new Set(["data", "analysis", "metric", "figure", "table", "report"]);
const OUTPUT_TYPES = new Set(["metric", "figure", "table", "data", "report"]);
const UNIVERSE_SOURCES = new Set(["explicit", "implicit", "none"]);

function fieldPath(path: string, key: string): string {
  return `${path}.${key}`;
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

class BundleValidator {
  readonly issues: ResolvedAnalysisBundleValidationIssue[] = [];

  private issue(
    code: ResolvedAnalysisBundleValidationIssueCode,
    path: string,
    message: string,
  ): void {
    this.issues.push({ code, path, message });
  }

  private field(
    record: UnknownRecord,
    key: string,
    path: string,
    required: boolean,
  ): unknown | typeof ABSENT {
    const target = fieldPath(path, key);
    if (!hasOwn(record, key) || record[key] === undefined) {
      if (required) this.issue("MISSING_PROPERTY", target, "Required property is missing");
      return ABSENT;
    }
    return record[key];
  }

  private object(value: unknown, path: string): UnknownRecord | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.issue("INVALID_TYPE", path, "Expected an object");
      return undefined;
    }
    return value as UnknownRecord;
  }

  private array(value: unknown, path: string): unknown[] | undefined {
    if (!Array.isArray(value)) {
      this.issue("INVALID_TYPE", path, "Expected an array");
      return undefined;
    }
    return value;
  }

  private requiredObject(
    record: UnknownRecord,
    key: string,
    path: string,
  ): UnknownRecord | undefined {
    const value = this.field(record, key, path, true);
    return value === ABSENT ? undefined : this.object(value, fieldPath(path, key));
  }

  private optionalObject(
    record: UnknownRecord,
    key: string,
    path: string,
  ): UnknownRecord | undefined {
    const value = this.field(record, key, path, false);
    return value === ABSENT ? undefined : this.object(value, fieldPath(path, key));
  }

  private requiredArray(
    record: UnknownRecord,
    key: string,
    path: string,
  ): unknown[] | undefined {
    const value = this.field(record, key, path, true);
    return value === ABSENT ? undefined : this.array(value, fieldPath(path, key));
  }

  private requiredString(record: UnknownRecord, key: string, path: string): string | undefined {
    const value = this.field(record, key, path, true);
    const target = fieldPath(path, key);
    if (value === ABSENT) return undefined;
    if (typeof value !== "string") {
      this.issue("INVALID_TYPE", target, "Expected a string");
      return undefined;
    }
    return value;
  }

  private optionalString(record: UnknownRecord, key: string, path: string): void {
    const value = this.field(record, key, path, false);
    if (value !== ABSENT && typeof value !== "string") {
      this.issue("INVALID_TYPE", fieldPath(path, key), "Expected a string");
    }
  }

  private requiredBoolean(record: UnknownRecord, key: string, path: string): void {
    const value = this.field(record, key, path, true);
    if (value !== ABSENT && typeof value !== "boolean") {
      this.issue("INVALID_TYPE", fieldPath(path, key), "Expected a boolean");
    }
  }

  private optionalBoolean(record: UnknownRecord, key: string, path: string): void {
    const value = this.field(record, key, path, false);
    if (value !== ABSENT && typeof value !== "boolean") {
      this.issue("INVALID_TYPE", fieldPath(path, key), "Expected a boolean");
    }
  }

  private optionalFiniteNumber(record: UnknownRecord, key: string, path: string): void {
    const value = this.field(record, key, path, false);
    if (value === ABSENT) return;
    const target = fieldPath(path, key);
    if (typeof value !== "number") {
      this.issue("INVALID_TYPE", target, "Expected a number");
    } else if (!Number.isFinite(value)) {
      this.issue("INVALID_VALUE", target, "Expected a finite number");
    }
  }

  private stringArray(value: unknown, path: string): void {
    const items = this.array(value, path);
    if (!items) return;
    items.forEach((item, index) => {
      if (typeof item !== "string") {
        this.issue("INVALID_TYPE", `${path}[${index}]`, "Expected a string");
      }
    });
  }

  private requiredStringArray(record: UnknownRecord, key: string, path: string): void {
    const value = this.field(record, key, path, true);
    if (value !== ABSENT) this.stringArray(value, fieldPath(path, key));
  }

  private optionalStringArray(record: UnknownRecord, key: string, path: string): void {
    const value = this.field(record, key, path, false);
    if (value !== ABSENT) this.stringArray(value, fieldPath(path, key));
  }

  private requiredLiteral(
    record: UnknownRecord,
    key: string,
    expected: string,
    path: string,
  ): void {
    const value = this.field(record, key, path, true);
    if (value === ABSENT) return;
    const target = fieldPath(path, key);
    if (typeof value !== "string") {
      this.issue("INVALID_TYPE", target, "Expected a string");
    } else if (value !== expected) {
      this.issue("INVALID_VALUE", target, `Expected ${JSON.stringify(expected)}`);
    }
  }

  private requiredEnum(
    record: UnknownRecord,
    key: string,
    values: ReadonlySet<string>,
    path: string,
  ): void {
    const value = this.field(record, key, path, true);
    if (value === ABSENT) return;
    if (typeof value !== "string") {
      this.issue("INVALID_TYPE", fieldPath(path, key), "Expected a string");
    } else if (!values.has(value)) {
      this.issue(
        "INVALID_VALUE",
        fieldPath(path, key),
        `Expected one of ${[...values].map((item) => JSON.stringify(item)).join(", ")}`,
      );
    }
  }

  validate(value: unknown): void {
    const bundle = this.object(value, "$");
    if (!bundle) return;

    const document = this.requiredObject(bundle, "document", "$");
    if (document) this.document(document, "$.document");

    const bindings = this.requiredArray(bundle, "bindings", "$");
    bindings?.forEach((binding, index) => this.binding(binding, `$.bindings[${index}]`));
  }

  private document(document: UnknownRecord, path: string): void {
    const schemaVersion = this.field(document, "schemaVersion", path, true);
    const schemaPath = fieldPath(path, "schemaVersion");
    if (schemaVersion !== ABSENT && typeof schemaVersion !== "string") {
      this.issue("INVALID_TYPE", schemaPath, "Expected a string");
    } else if (
      schemaVersion !== ABSENT &&
      schemaVersion !== RESOLVED_ANALYSIS_SCHEMA_VERSION
    ) {
      this.issue(
        "UNSUPPORTED_SCHEMA_VERSION",
        schemaPath,
        `Expected ${JSON.stringify(RESOLVED_ANALYSIS_SCHEMA_VERSION)}`,
      );
    }

    const universe = this.requiredObject(document, "universe", path);
    if (universe) this.universe(universe, fieldPath(path, "universe"));

    const analysis = this.requiredObject(document, "analysis", path);
    if (analysis) this.analysis(analysis, fieldPath(path, "analysis"), true, new Set());
  }

  private universe(universe: UnknownRecord, path: string): void {
    this.requiredString(universe, "universeId", path);
    this.optionalString(universe, "description", path);
    this.requiredStringArray(universe, "availableUniverseIds", path);
    this.requiredEnum(universe, "source", UNIVERSE_SOURCES, path);
  }

  private analysis(
    analysis: UnknownRecord,
    path: string,
    root: boolean,
    ancestors: Set<object>,
  ): void {
    if (ancestors.has(analysis)) {
      this.issue("CYCLIC_ANALYSIS", path, "Analysis hierarchy must not contain a cycle");
      return;
    }
    ancestors.add(analysis);

    if (root) {
      this.optionalString(analysis, "id", path);
      this.requiredString(analysis, "version", path);
      this.requiredString(analysis, "name", path);
    } else {
      this.requiredString(analysis, "id", path);
      this.optionalString(analysis, "version", path);
      this.optionalString(analysis, "name", path);
    }
    this.requiredString(analysis, "canonicalPath", path);
    this.optionalString(analysis, "description", path);
    this.optionalString(analysis, "container", path);
    this.optionalStringArray(analysis, "tags", path);

    const inputs = this.requiredArray(analysis, "inputs", path);
    inputs?.forEach((input, index) => this.input(input, `${path}.inputs[${index}]`));

    const outputs = this.requiredArray(analysis, "outputs", path);
    outputs?.forEach((output, index) => this.output(output, `${path}.outputs[${index}]`));

    const decisions = this.requiredArray(analysis, "decisions", path);
    decisions?.forEach((decision, index) => this.decision(decision, `${path}.decisions[${index}]`));

    const priorInsights = this.requiredArray(analysis, "prior_insights", path);
    priorInsights?.forEach((insight, index) =>
      this.insight(insight, `${path}.prior_insights[${index}]`, "prior_insight"));

    const findings = this.requiredArray(analysis, "findings", path);
    findings?.forEach((finding, index) =>
      this.insight(finding, `${path}.findings[${index}]`, "finding"));

    const children = this.requiredArray(analysis, "analyses", path);
    children?.forEach((child, index) => {
      const childPath = `${path}.analyses[${index}]`;
      const record = this.object(child, childPath);
      if (record) this.analysis(record, childPath, false, ancestors);
    });

    ancestors.delete(analysis);
  }

  private resolvedIdentity(record: UnknownRecord, path: string, kind: string): void {
    this.requiredString(record, "id", path);
    this.requiredLiteral(record, "kind", kind, path);
    this.requiredString(record, "canonicalPath", path);
  }

  private input(value: unknown, path: string): void {
    const input = this.object(value, path);
    if (!input) return;
    this.resolvedIdentity(input, path, "input");
    this.requiredEnum(input, "type", INPUT_TYPES, path);
    for (const key of [
      "label",
      "description",
      "source",
      "ref",
      "ref_version",
      "from",
      "resolvedFrom",
    ]) {
      this.optionalString(input, key, path);
    }
    this.optionalStringArray(input, "use_outputs", path);
  }

  private output(value: unknown, path: string): void {
    const output = this.object(value, path);
    if (!output) return;
    this.resolvedIdentity(output, path, "output");
    this.requiredEnum(output, "type", OUTPUT_TYPES, path);
    this.requiredBoolean(output, "active", path);
    for (const key of ["label", "format", "description", "from", "resolvedFrom"]) {
      this.optionalString(output, key, path);
    }
    for (const key of ["inputs", "decisions", "when"]) {
      this.optionalStringArray(output, key, path);
    }

    const recipe = this.optionalObject(output, "recipe", path);
    if (recipe) this.recipe(recipe, fieldPath(path, "recipe"));

    const provenance = this.requiredObject(output, "provenance", path);
    if (provenance) {
      const provenancePath = fieldPath(path, "provenance");
      this.requiredStringArray(provenance, "inputPaths", provenancePath);
      this.requiredStringArray(provenance, "decisionPaths", provenancePath);
    }

    const artifact = this.optionalObject(output, "artifact", path);
    if (artifact) {
      const artifactPath = fieldPath(path, "artifact");
      const byteSize = this.field(artifact, "byteSize", artifactPath, true);
      const byteSizePath = fieldPath(artifactPath, "byteSize");
      if (byteSize !== ABSENT && typeof byteSize !== "number") {
        this.issue("INVALID_TYPE", byteSizePath, "Expected a number");
      } else if (
        byteSize !== ABSENT &&
        (!Number.isFinite(byteSize) || byteSize < 0)
      ) {
        this.issue("INVALID_VALUE", byteSizePath, "Expected a non-negative finite number");
      }
    }
  }

  private recipe(recipe: UnknownRecord, path: string): void {
    this.optionalString(recipe, "command", path);
    this.optionalString(recipe, "container", path);
    const resources = this.optionalObject(recipe, "resources", path);
    if (!resources) return;
    const resourcesPath = fieldPath(path, "resources");
    this.optionalFiniteNumber(resources, "cpus", resourcesPath);
    this.optionalFiniteNumber(resources, "gpus", resourcesPath);
    for (const key of ["memory", "time_limit", "disk"]) {
      this.optionalString(resources, key, resourcesPath);
    }
  }

  private decision(value: unknown, path: string): void {
    const decision = this.object(value, path);
    if (!decision) return;
    this.resolvedIdentity(decision, path, "decision");
    this.requiredString(decision, "label", path);
    this.requiredBoolean(decision, "active", path);
    for (const key of ["rationale", "default", "from", "resolvedFrom", "selectedOptionId"]) {
      this.optionalString(decision, key, path);
    }
    this.optionalStringArray(decision, "tags", path);
    this.optionalStringArray(decision, "when", path);

    const options = this.requiredArray(decision, "options", path);
    options?.forEach((option, index) => this.option(option, `${path}.options[${index}]`));
  }

  private option(value: unknown, path: string): void {
    const option = this.object(value, path);
    if (!option) return;
    this.requiredString(option, "id", path);
    this.requiredString(option, "label", path);
    this.optionalString(option, "description", path);
    this.optionalString(option, "excluded_reason", path);
    this.optionalBoolean(option, "excluded", path);
    for (const key of ["insights", "incompatible_with", "requires"]) {
      this.optionalStringArray(option, key, path);
    }
    this.requiredStringArray(option, "resolvedInsightPaths", path);
  }

  private insight(value: unknown, path: string, kind: "finding" | "prior_insight"): void {
    const insight = this.object(value, path);
    if (!insight) return;
    this.resolvedIdentity(insight, path, kind);
    this.requiredString(insight, "claim", path);
    this.requiredString(insight, "created_at", path);
    for (const key of ["label", "snapshot", "source_commit", "scope", "notes"]) {
      this.optionalString(insight, key, path);
    }
    this.optionalBoolean(insight, "derived", path);
    this.optionalStringArray(insight, "tags", path);

    const evidence = this.requiredArray(insight, "evidence", path);
    evidence?.forEach((item, index) => this.evidence(item, `${path}.evidence[${index}]`));
  }

  private evidence(value: unknown, path: string): void {
    const evidence = this.object(value, path);
    if (!evidence) return;
    this.requiredString(evidence, "id", path);
    for (const key of ["doi", "artifact", "snapshot", "source_commit", "resolvedOutputPath"]) {
      this.optionalString(evidence, key, path);
    }
    this.optionalFiniteNumber(evidence, "version", path);

    const quote = this.optionalObject(evidence, "quote", path);
    if (quote) {
      const quotePath = fieldPath(path, "quote");
      this.requiredString(quote, "exact", quotePath);
      this.optionalString(quote, "prefix", quotePath);
      this.optionalString(quote, "suffix", quotePath);
    }

    const location = this.optionalObject(evidence, "location", path);
    if (location) {
      const locationPath = fieldPath(path, "location");
      this.optionalString(location, "value", locationPath);
      this.optionalFiniteNumber(location, "page", locationPath);
    }
  }

  private binding(value: unknown, path: string): void {
    const binding = this.object(value, path);
    if (!binding) return;
    this.requiredString(binding, "outputPath", path);
    this.requiredString(binding, "path", path);
    this.requiredString(binding, "cacheToken", path);
  }
}

function validationIssues(value: unknown): ResolvedAnalysisBundleValidationIssue[] {
  const validator = new BundleValidator();
  validator.validate(value);
  return validator.issues;
}

/**
 * Return whether already-deserialized transport data has the complete current
 * `ResolvedAnalysisBundle` shape. This performs no project I/O or resolution.
 */
export function isResolvedAnalysisBundle(value: unknown): value is ResolvedAnalysisBundle {
  return validationIssues(value).length === 0;
}

/**
 * Validate already-deserialized transport data and return it with the SDK type.
 * The original object is returned unchanged; invalid data throws a structured
 * `ResolvedAnalysisBundleValidationError`.
 */
export function parseResolvedAnalysisBundle(value: unknown): ResolvedAnalysisBundle {
  const issues = validationIssues(value);
  if (issues.length) throw new ResolvedAnalysisBundleValidationError(issues);
  return value as ResolvedAnalysisBundle;
}
