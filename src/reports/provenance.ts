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
  /** Selection context, including pins on an authored switch chain. */
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

/** Decisions on the selected authored switch chain for one effective input edge. */
function switchDecisions(
  index: ResolvedAnalysisIndex,
  result: Result,
  source: Source,
  route: readonly ProvenanceStep[],
): ProvenanceDecision[] {
  const output = index.elementByRef.get(result.output);
  if (output?.collection !== "outputs") return [];
  let reference = output.element.inputs?.find(
    (input) => input.entry === source.entry,
  );
  let universe = result.universe;
  const found: ProvenanceDecision[] = [],
    seen = new Set<string>();
  while (reference) {
    universe = reference.universe ?? universe;
    const target = index.elementByRef.get(reference.target);
    if (target?.collection !== "switches") break;
    const identity = JSON.stringify([target.element.ref, universe]);
    if (seen.has(identity)) break;
    seen.add(identity);
    const decision = index.elementByRef.get(target.element.decision);
    if (decision?.collection !== "decisions") break;
    const option =
      universe === undefined
        ? undefined
        : getSelectedOption(index, universe, decision.element.ref);
    found.push({
      result,
      route,
      decision: decision.element,
      ...(universe === undefined ? {} : { universe }),
      ...(option === undefined ? {} : { option }),
    });
    reference =
      option && Object.hasOwn(target.element.cases, option.id)
        ? target.element.cases[option.id]
        : undefined;
  }
  return found;
}

/**
 * Trace the seed and its dependencies in depth-first input order. Occurrences are
 * retained per route, including two pins to the same output. Only ancestors on
 * the current route are excluded, so diamonds keep both paths and cycles terminate.
 * Universes come from each result and authored switch pins, never from the caller.
 */
export function traceResultProvenance(
  index: ResolvedAnalysisIndex,
  resultId: string,
): ResultProvenance {
  const decisions: ProvenanceDecision[] = [];
  const inputs: ProvenanceInput[] = [];
  const seed = index.resultById.get(resultId);
  if (!seed) return { decisions, inputs };
  const pending: (ProvenanceContext & { source?: Source })[] = [
    { result: seed, route: [] },
  ];
  while (pending.length) {
    const { result, route, source } = pending.pop()!;
    if (source) {
      decisions.push(...switchDecisions(index, result, source, route));
      if (source.result !== undefined) {
        const upstream = index.resultById.get(source.result);
        if (upstream) pending.push({ result: upstream, route });
      } else if (source.input !== undefined) {
        const found = index.elementByRef.get(source.input);
        if (found?.collection === "inputs")
          inputs.push({ result, route, input: found.element });
      }
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
      pending.push({ result, route: routeToSource, source });
    }
  }
  return { decisions, inputs };
}
