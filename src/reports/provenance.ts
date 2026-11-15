/** Contextual provenance over effective result edges, without project I/O. */
import type { ResolvedAnalysisIndex } from "./index-analysis.js";
import type { Decision, Input, Option, Result, Source } from "./types.js";
import { getSelectedOption } from "./selectors.js";

export interface ProvenanceStep {
  readonly result: Result;
  readonly source: Source;
}
export interface ProvenanceContext {
  readonly result: Result;
  /** Edges from the seed to this occurrence, retaining distinct dependency routes. */
  readonly route: readonly ProvenanceStep[];
}
export interface ProvenanceDecision extends ProvenanceContext {
  readonly decision: Decision;
  readonly universe?: string;
  readonly option?: Option;
}
export interface ProvenanceInput extends ProvenanceContext {
  readonly input: Input;
}
export interface ResultProvenance {
  readonly decisions: readonly ProvenanceDecision[];
  readonly inputs: readonly ProvenanceInput[];
}

/**
 * Trace the seed and its dependencies in depth-first input order. Occurrences are
 * retained per route, including two pins to the same output. Only ancestors on
 * the current route are excluded, so diamonds keep both paths and cycles terminate.
 * Universes come from each result, never from the caller's selected universe.
 */
export function traceResultProvenance(
  index: ResolvedAnalysisIndex,
  resultId: string,
): ResultProvenance {
  const decisions: ProvenanceDecision[] = [];
  const inputs: ProvenanceInput[] = [];
  const seed = index.resultById.get(resultId);
  if (!seed) return { decisions, inputs };
  const pending: (ProvenanceContext & { input?: Input })[] = [
    { result: seed, route: [] },
  ];
  while (pending.length) {
    const { result, route, input } = pending.pop()!;
    if (input) {
      inputs.push({ result, route, input });
      continue;
    }
    if (route.some((step) => step.result.id === result.id)) continue;
    const output = index.elementByRef.get(result.output);
    if (output?.collection !== "outputs") continue;
    for (const ref of output.element.decisions) {
      const found = index.elementByRef.get(ref);
      if (found?.collection !== "decisions") continue;
      const option =
        result.universe === undefined
          ? undefined
          : getSelectedOption(index, result.universe, ref);
      decisions.push({
        result,
        route,
        decision: found.element,
        ...(result.universe === undefined ? {} : { universe: result.universe }),
        ...(option === undefined ? {} : { option }),
      });
    }
    for (const source of [...result.inputs].reverse()) {
      const routeToSource = [...route, { result, source }];
      if (source.result !== undefined) {
        const upstream = index.resultById.get(source.result);
        if (upstream) pending.push({ result: upstream, route: routeToSource });
      } else if (source.input !== undefined) {
        const found = index.elementByRef.get(source.input);
        if (found?.collection === "inputs")
          pending.push({ result, route: routeToSource, input: found.element });
      }
    }
  }
  return { decisions, inputs };
}
