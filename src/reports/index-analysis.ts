/** Derived lookups over the resolved report, with original objects retained. */

import type {
  Analysis,
  Decision,
  Input,
  Insight,
  Output,
  ResolvedAnalysis,
  Result,
  Universe,
  Switch,
} from "./types.js";

interface ElementTypes {
  inputs: Input;
  outputs: Output;
  decisions: Decision;
  prior_insights: Insight;
  findings: Insight;
  universes: Universe;
  switches: Switch;
}

export type ElementCollection = keyof ElementTypes;

/** An element and the analysis that declares it; the collection narrows its type. */
export type IndexedElement = {
  [Collection in ElementCollection]: {
    readonly collection: Collection;
    readonly analysis: Analysis;
    readonly element: ElementTypes[Collection];
  };
}[ElementCollection];

export interface ResolvedAnalysisIndex {
  readonly analysisByKey: ReadonlyMap<string, Analysis>;
  readonly elementByRef: ReadonlyMap<string, IndexedElement>;
  readonly resultById: ReadonlyMap<string, Result>;
  /** All planned results for an output, in the report's order. */
  readonly resultsByOutput: ReadonlyMap<string, readonly Result[]>;
}

export type ReportIndexErrorCode =
  | "DUPLICATE_ANALYSIS_KEY"
  | "DUPLICATE_ELEMENT_REF"
  | "DUPLICATE_RESULT_ID";

/** A duplicate identity would make the derived lookups ambiguous. */
export class ReportIndexError extends Error {
  constructor(
    readonly code: ReportIndexErrorCode,
    readonly key: string,
  ) {
    super(`${code}: ${JSON.stringify(key)}`);
    this.name = "ReportIndexError";
  }
}

function add<T>(
  map: Map<string, T>,
  key: string,
  value: T,
  code: ReportIndexErrorCode,
): void {
  if (map.has(key)) throw new ReportIndexError(code, key);
  map.set(key, value);
}

const COLLECTIONS = [
  "inputs", "outputs", "decisions", "prior_insights", "findings", "universes", "switches",
] as const;

/**
 * Index a resolved report without parsing refs or changing its data.
 *
 * This checks identity uniqueness, not ASTRA semantics or reference integrity.
 * The readonly maps are derived views; callers should not mutate the report
 * after building them.
 */
export function indexResolvedAnalysis(report: ResolvedAnalysis): ResolvedAnalysisIndex {
  const analysisByKey = new Map<string, Analysis>();
  const elementByRef = new Map<string, IndexedElement>();
  const resultById = new Map<string, Result>();
  const resultsByOutput = new Map<string, Result[]>();

  for (const analysis of report.analyses) {
    add(analysisByKey, analysis.key, analysis, "DUPLICATE_ANALYSIS_KEY");
    for (const collection of COLLECTIONS) {
      for (const element of analysis[collection] ?? []) {
        // Membership in this collection establishes the correlated element type.
        const entry = { collection, analysis, element } as IndexedElement;
        add(elementByRef, element.ref, entry, "DUPLICATE_ELEMENT_REF");
      }
    }
  }
  for (const result of report.results) {
    add(resultById, result.id, result, "DUPLICATE_RESULT_ID");
    const group = resultsByOutput.get(result.output);
    if (group) group.push(result);
    else resultsByOutput.set(result.output, [result]);
  }
  return { analysisByKey, elementByRef, resultById, resultsByOutput };
}
