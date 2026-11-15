/** Lookups over resolved reports, including retained scoped evidence addresses. */

import type { ResolvedAnalysisIndex } from "./index-analysis.js";
import type { Analysis, Evidence, EvidenceBinding, Option, Output, Result } from "./types.js";

/** Follow one declaration, retaining aliases and the root's empty key. */
export function getDeclaredAnalysis(
  index: ResolvedAnalysisIndex,
  analysisKey: string,
  declarationId: string,
): Analysis | undefined {
  const analysis = index.analysisByKey.get(analysisKey);
  if (!analysis || !Object.hasOwn(analysis.declares, declarationId)) return undefined;
  return index.analysisByKey.get(analysis.declares[declarationId]!);
}

/** Depth-first declaration order, visiting each analysis once despite aliases or cycles. */
export function* walkAnalyses(
  index: ResolvedAnalysisIndex,
  startKey = "",
): Generator<Analysis> {
  const pending = [startKey];
  const visited = new Set<string>();
  while (pending.length) {
    const key = pending.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    const analysis = index.analysisByKey.get(key);
    if (!analysis) continue;
    yield analysis;
    const declared = Object.values(analysis.declares);
    for (let position = declared.length - 1; position >= 0; position -= 1) {
      pending.push(declared[position]!);
    }
  }
}

/** A varying result belongs to its universe's analysis; a once-built one to its output's. */
export function getResultOwner(
  index: ResolvedAnalysisIndex,
  resultId: string,
): Analysis | undefined {
  const result = index.resultById.get(resultId);
  if (!result) return undefined;
  const owner = index.elementByRef.get(result.universe ?? result.output);
  const collection = result.universe === undefined ? "outputs" : "universes";
  return owner?.collection === collection ? owner.analysis : undefined;
}

/** Exact output/universe pair; omit universeRef to request the once-built result only. */
export function getResult(
  index: ResolvedAnalysisIndex,
  outputRef: string,
  universeRef?: string,
): Result | undefined {
  if (index.elementByRef.get(outputRef)?.collection !== "outputs") return undefined;
  return index.resultsByOutput.get(outputRef)?.find((result) => result.universe === universeRef);
}

/** Select one output's result in a known universe, falling back to its once-built result. */
export function selectResult(
  index: ResolvedAnalysisIndex,
  outputRef: string,
  universeRef: string,
): Result | undefined {
  if (index.elementByRef.get(universeRef)?.collection !== "universes") return undefined;
  return getResult(index, outputRef, universeRef) ?? getResult(index, outputRef);
}

/** The effective selected option, or undefined where the universe has no such selection. */
export function getSelectedOption(
  index: ResolvedAnalysisIndex,
  universeRef: string,
  decisionRef: string,
): Option | undefined {
  const universe = index.elementByRef.get(universeRef);
  const decision = index.elementByRef.get(decisionRef);
  if (universe?.collection !== "universes" || decision?.collection !== "decisions") return undefined;
  if (!Object.hasOwn(universe.element.selection, decisionRef)) return undefined;
  const selected = universe.element.selection[decisionRef];
  return decision.element.options.find((option) => option.id === selected);
}

function pushDependencies(pending: string[], result: Result): void {
  for (let position = result.inputs.length - 1; position >= 0; position -= 1) {
    const id = result.inputs[position]!.result;
    if (id !== undefined) pending.push(id);
  }
}

/** Unique upstream results in depth-first input order, excluding the seed and following pins. */
export function* walkResultDependencies(
  index: ResolvedAnalysisIndex,
  resultId: string,
): Generator<Result> {
  const seed = index.resultById.get(resultId);
  if (!seed) return;
  const visited = new Set([resultId]);
  const pending: string[] = [];
  pushDependencies(pending, seed);
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const result = index.resultById.get(id);
    if (!result) continue;
    yield result;
    pushDependencies(pending, result);
  }
}

/** Evidence identity is the insight ref and its zero-based evidence index. */
export function getEvidence(
  index: ResolvedAnalysisIndex,
  insightRef: string,
  evidenceIndex: number,
): Evidence | undefined {
  if (!Number.isSafeInteger(evidenceIndex) || evidenceIndex < 0) return undefined;
  const insight = index.elementByRef.get(insightRef);
  if (insight?.collection !== "prior_insights" && insight?.collection !== "findings") return undefined;
  return insight.element.evidence[evidenceIndex];
}

/** Follow an authored evidence address to a concrete output, even without a planned result. */
export function getEvidenceOutput(
  index: ResolvedAnalysisIndex,
  insightRef: string,
  evidenceIndex: number,
): Output | undefined {
  const artifact = getEvidence(index, insightRef, evidenceIndex)?.artifact;
  // Report decoders do not validate authored address grammar. Require a whole
  // reference; in particular, a trailing newline must not pass the `$` anchor.
  if (
    !artifact ||
    artifact.match(
      /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*(?:#[a-z][a-z0-9_]*)?$/,
    )?.[0] !== artifact
  )
    return undefined;
  let analysis = index.elementByRef.get(insightRef)?.analysis;
  const segments = artifact.split("#", 1)[0]!.split(".");
  const id = segments.pop()!;
  for (const declaration of segments) {
    analysis = analysis && getDeclaredAnalysis(index, analysis.key, declaration);
    if (!analysis) return undefined;
  }
  if (!analysis) return undefined;
  const ref = `${analysis.key ? `${analysis.key}.` : ""}outputs.${id}`;
  const found = index.elementByRef.get(ref);
  return found?.collection === "outputs" ? found.element : undefined;
}

/** All effective citations in citation order; use getEvidenceBindings for contextual selection. */
export function getCitedResults(
  index: ResolvedAnalysisIndex,
  insightRef: string,
  evidenceIndex: number,
): readonly Result[] {
  const cited: Result[] = [];
  for (const id of getEvidence(index, insightRef, evidenceIndex)?.cites ?? []) {
    const result = index.resultById.get(id);
    if (result) cited.push(result);
  }
  return cited;
}

/**
 * Bindings for an evaluation universe, retaining universe-independent and explicitly
 * pinned evidence. Omit universeRef for every evaluation. Undefined means the report
 * has no binding information (older reports or DOI evidence), not an empty selection.
 */
export function getEvidenceBindings(
  index: ResolvedAnalysisIndex,
  insightRef: string,
  evidenceIndex: number,
  universeRef?: string,
): readonly EvidenceBinding[] | undefined {
  const evidence = getEvidence(index, insightRef, evidenceIndex);
  if (universeRef === undefined || evidence?.artifact?.includes("#")) return evidence?.bindings;
  return evidence?.bindings?.filter(binding => binding.universe === undefined || binding.universe === universeRef);
}
