import { walkAnalyses } from "./index-analysis.js";
import type { ResolvedAnalysisDocument } from "./resolved-types.js";

const DOI_URL_PREFIX = /^https?:\/\/(?:dx\.)?doi\.org\//i;
const DOI_LABEL_PREFIX = /^doi:\s*/i;

/** Normalize common DOI spellings to an opaque, case-insensitive key. Does not validate a DOI. */
export function normalizeDoi(value: string): string {
  return value
    .trim()
    .replace(DOI_LABEL_PREFIX, "")
    .replace(DOI_URL_PREFIX, "")
    .trim()
    .toLowerCase();
}

/** Collect unique cited DOIs in resolved document order. */
export function collectCitedDois(
  document: ResolvedAnalysisDocument,
): string[] {
  const dois = new Set<string>();
  for (const analysis of walkAnalyses(document)) {
    for (const insight of [
      ...analysis.prior_insights,
      ...analysis.findings,
    ]) {
      for (const evidence of insight.evidence) {
        if (typeof evidence.doi !== "string") continue;
        const doi = normalizeDoi(evidence.doi);
        if (doi) dois.add(doi);
      }
    }
  }
  return [...dois];
}
