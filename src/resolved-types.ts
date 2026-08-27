import type {
  Analysis,
  Decision,
  Evidence,
  Input,
  InputType,
  Insight,
  Option,
  Output,
  OutputType,
} from "./types.js";

export const RESOLVED_ANALYSIS_SCHEMA_VERSION =
  "astra-resolved-analysis.v1" as const;

export interface UniverseSelection {
  /** Selected universe id, or `default` when no universe file exists. */
  universeId: string;
  description?: string;
  availableUniverseIds: string[];
  source: "explicit" | "implicit" | "none";
}

export interface ResolvedAnalysisDocument {
  schemaVersion: typeof RESOLVED_ANALYSIS_SCHEMA_VERSION;
  universe: UniverseSelection;
  analysis: ResolvedAnalysisNode;
}

export interface ResolvedRecordFields {
  canonicalPath: string;
}

export type ResolvedInput = Omit<Input, "type"> & ResolvedRecordFields & {
  kind: "input";
  /** An input alias may inherit the type of a sibling output. */
  type: InputType | OutputType;
  /** Ultimate alias target. The authored `from` value is retained. */
  resolvedFrom?: string;
};

export interface OutputProvenance {
  inputPaths: string[];
  decisionPaths: string[];
}

export interface ArtifactDescriptor {
  byteSize: number;
}

export type ResolvedOutput = Omit<Output, "type"> & ResolvedRecordFields & {
  kind: "output";
  type: OutputType;
  active: boolean;
  /** Ultimate alias target. The authored `from` value is retained. */
  resolvedFrom?: string;
  provenance: OutputProvenance;
  artifact?: ArtifactDescriptor;
};

export type ResolvedOption = Option & {
  id: string;
  resolvedInsightPaths: string[];
};

export type ResolvedDecision = Omit<Decision, "label" | "options"> &
  ResolvedRecordFields & {
    id: string;
    kind: "decision";
    label: string;
    active: boolean;
    /** Ultimate alias target. The authored `from` value is retained. */
    resolvedFrom?: string;
    options: ResolvedOption[];
    selectedOptionId?: string;
  };

export type ResolvedEvidence = Evidence & {
  /** Canonical path of the output named by `artifact`. */
  resolvedOutputPath?: string;
};

export type ResolvedInsight = Omit<Insight, "evidence"> &
  ResolvedRecordFields & {
    kind: "finding" | "prior_insight";
    evidence: ResolvedEvidence[];
  };

export type ResolvedChildAnalysis = ResolvedAnalysisNode & { id: string };

export type ResolvedAnalysisNode = Omit<
  Analysis,
  | "path"
  | "inputs"
  | "outputs"
  | "decisions"
  | "prior_insights"
  | "findings"
  | "analyses"
> & {
  /** `$` for the root, then dotted analysis ids for descendants. */
  canonicalPath: string;
  inputs: ResolvedInput[];
  outputs: ResolvedOutput[];
  decisions: ResolvedDecision[];
  prior_insights: ResolvedInsight[];
  findings: ResolvedInsight[];
  analyses: ResolvedChildAnalysis[];
};

export type ResolvedRecord =
  | ResolvedInput
  | ResolvedOutput
  | ResolvedDecision
  | ResolvedInsight;

export interface ArtifactBinding {
  /** Canonical path of the output that exposes this artifact. */
  outputPath: string;
  /** Project-relative path to the deterministic artifact file. */
  path: string;
  /** Opaque equality token for cache-busting reads of this file. */
  cacheToken: string;
}

export interface ResolvedAnalysisBundle {
  document: ResolvedAnalysisDocument;
  bindings: ArtifactBinding[];
}
