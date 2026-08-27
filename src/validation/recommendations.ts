// Fields the ASTRA schema marks `recommended: true` rather than `required`.
// Omitting one is not an error — the document validates — but it will become
// one, so this reports it while there is still time to act.
//
// Kept out of `validateAnalysis`, whose `SemanticError[]` return is an
// error-only channel: a caller treats a non-empty result as invalid, and a
// recommendation must never make an analysis invalid.

import { type Dict, asArray, asDict } from "../helpers.js";
import type { ResolvedAnalysisNode } from "../resolved-types.js";
import type { Analysis } from "../types.js";

/** The release that turns the recommendations below into requirements. */
export const RECOMMENDED_UNTIL = "0.1.0";

function walk(node: Dict, scope: readonly string[], missing: string[]): void {
  for (const raw of asArray(node.outputs)) {
    const output = asDict(raw);
    if (!output) continue;
    // A re-export inherits `format` from its source and is forbidden from
    // declaring one, so asking it for a format would be asking for a schema
    // violation.
    if (output.from || output.format) continue;
    const localId = typeof output.id === "string" ? output.id : undefined;
    if (!localId) continue;
    missing.push([...scope, localId].join("."));
  }
  if (Array.isArray(node.analyses)) {
    for (const raw of node.analyses) {
      const sub = asDict(raw);
      if (sub && typeof sub.id === "string") {
        walk(sub, [...scope, sub.id], missing);
      }
    }
  } else {
    const analyses = asDict(node.analyses) ?? {};
    for (const [subId, raw] of Object.entries(analyses)) {
      const sub = asDict(raw);
      if (sub) walk(sub, [...scope, subId], missing);
    }
  }
}

/**
 * Report recommended-but-absent fields anywhere in the analysis tree.
 *
 * Returns human-readable messages, empty when there is nothing to say. These
 * are advisory: they never make an analysis invalid.
 *
 * For a full multi-file project, pass `bundle.document.analysis` from
 * `resolveAnalysis()`. An authored path-backed child is only a reference and
 * does not contain the child file's outputs.
 */
export function collectRecommendations(
  data: Analysis | ResolvedAnalysisNode | Dict,
): string[] {
  const missingFormat: string[] = [];
  walk(data as Dict, [], missingFormat);

  if (!missingFormat.length) return [];
  const subject = missingFormat.length === 1 ? "output" : "outputs";
  return [
    `${missingFormat.length} ${subject} without a 'format': ${missingFormat.join(", ")}. `
      + `Optional today, required from ASTRA ${RECOMMENDED_UNTIL} — add the artifact's `
      + `file extension, e.g. 'format: png'.`,
  ];
}
