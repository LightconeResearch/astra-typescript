import type {
  ResolvedAnalysisDocument,
  ResolvedAnalysisNode,
  ResolvedRecord,
} from "./resolved-types.js";

export interface AnalysisIndex {
  analysisByPath: ReadonlyMap<string, ResolvedAnalysisNode>;
  recordByPath: ReadonlyMap<string, ResolvedRecord>;
}

/** Build optional lookup maps from the recursive resolved document. */
export function indexAnalysis(document: ResolvedAnalysisDocument): AnalysisIndex {
  const analysisByPath = new Map<string, ResolvedAnalysisNode>();
  const recordByPath = new Map<string, ResolvedRecord>();

  const visit = (analysis: ResolvedAnalysisNode): void => {
    analysisByPath.set(analysis.canonicalPath, analysis);
    for (const record of [
      ...analysis.inputs,
      ...analysis.outputs,
      ...analysis.decisions,
      ...analysis.prior_insights,
      ...analysis.findings,
    ]) {
      recordByPath.set(record.canonicalPath, record);
    }
    for (const child of analysis.analyses) visit(child);
  };

  visit(document.analysis);
  return { analysisByPath, recordByPath };
}

/** Depth-first traversal in the ordering defined by the resolved contract. */
export function* walkAnalyses(
  document: ResolvedAnalysisDocument,
): Generator<ResolvedAnalysisNode> {
  const pending: ResolvedAnalysisNode[] = [document.analysis];
  while (pending.length) {
    const analysis = pending.pop()!;
    yield analysis;
    for (let index = analysis.analyses.length - 1; index >= 0; index -= 1) {
      pending.push(analysis.analyses[index]!);
    }
  }
}
