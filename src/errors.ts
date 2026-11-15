import type { ValidationReport } from "./reports/types.js";

export { CacheError, GitError, NoAnalysisError } from "./sources/errors.js";

/** Resolution and status require an analysis that breaks no MUST rule. */
export class InvalidAnalysisError extends Error {
  constructor(readonly report: ValidationReport) {
    super(`Invalid ASTRA analysis: ${report.root}`);
    this.name = "InvalidAnalysisError";
  }
}
