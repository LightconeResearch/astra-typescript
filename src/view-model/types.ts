// The canonical, host-neutral projection of an ASTRA project for viewers:
// `project-view-model.v1`. Hosts (JupyterLab, VSCode, the MyST build) project
// an analysis tree into this one serializable document; UI packages render it
// without ever parsing ASTRA YAML themselves. The document carries metadata
// only — no filesystem paths, URLs, or bytes.

export const PROJECT_VIEW_MODEL_SCHEMA_VERSION = "project-view-model.v1" as const;

export type ProjectViewModelSchemaVersion =
  typeof PROJECT_VIEW_MODEL_SCHEMA_VERSION;

export type AstraRecordKind =
  | "input"
  | "decision"
  | "output"
  | "finding"
  | "prior_insight";

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface ViewModelDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  canonicalPath?: string;
  sourceUri?: string;
}

export interface ProjectRevision {
  /** Revision of astra.yaml and every resolved child analysis. */
  analysis: string;
  /** Revision of the explicit universe selection, when one is present. */
  selection?: string;
}

export interface ProjectIdentity {
  id: string;
  name: string;
  description?: string;
  astraVersion?: string;
}

export type UniverseSelectionSource =
  | "explicit"
  | "default"
  | "none"
  | "unknown";

export interface ProjectSelection {
  universeId?: string;
  availableUniverses: string[];
  /** Selected option ids keyed by canonical decision record id. */
  decisions: Record<string, string>;
  source: UniverseSelectionSource;
}

export interface ProjectScopeView {
  id: string;
  /** Canonical analysis path. The root conventionally uses `root`. */
  canonicalPath: string;
  name: string;
  description?: string;
  parentId?: string;
  childIds: string[];
  recordIds: string[];
  sourceUri?: string;
}

export interface RecipeDescriptor {
  command?: string;
  container?: string;
}

export interface DecisionOptionView {
  id: string;
  label?: string;
  description?: string;
  selected: boolean;
  excluded?: boolean;
  exclusionReason?: string;
  insightRecordIds?: string[];
}

export interface EvidenceDescriptor {
  artifactRecordId?: string;
  doi?: string;
  quote?: string;
  page?: number;
}

export type RecordRelationKind =
  | "contains"
  | "depends_on"
  | "parameterized_by"
  | "informed_by"
  | "evidenced_by"
  | "aliases"
  | "derived_from";

export interface RecordRelation {
  kind: RecordRelationKind;
  targetRecordId: string;
  direct?: boolean;
  label?: string;
}

export interface MetricValue {
  value?: number | string;
  uncertainty?: number | string;
  unit?: string;
  label?: string;
}

export interface ProvenanceReference {
  /** Authored ASTRA reference, retained even when it cannot be resolved. */
  reference: string;
  /** Canonical model record id when the reference resolves uniquely. */
  recordId?: string;
  label?: string;
  scopeId?: string;
  selection?: string;
  direct: boolean;
}

export interface OutputProvenance {
  inputs: ProvenanceReference[];
  decisions: ProvenanceReference[];
}

export interface BaseRecordView {
  /** Stable within one project revision; not a global citation identifier. */
  id: string;
  /** The authored ASTRA id before host-safe project/scope namespacing. */
  localId: string;
  canonicalPath: string;
  scopeId: string;
  kind: AstraRecordKind;
  label?: string;
  description?: string;
  sourceUri?: string;
  active?: boolean;
  tags?: string[];
  relations: RecordRelation[];
}

export interface InputRecordView extends BaseRecordView {
  kind: "input";
  inputType?: string;
  source?: string;
  reference?: string;
}

export interface DecisionRecordView extends BaseRecordView {
  kind: "decision";
  rationale?: string;
  selectedOptionId?: string;
  options: DecisionOptionView[];
}

export type ViewOutputType =
  | "figure"
  | "table"
  | "metric"
  | "dataset"
  | "report"
  | "file"
  | "other";

export interface OutputRecordView extends BaseRecordView {
  kind: "output";
  outputType: ViewOutputType;
  recipe?: RecipeDescriptor;
  /** References descriptors; it never contains file paths, URLs, or bytes. */
  resourceIds: string[];
  /** Complete authored provenance, including unresolved references. */
  provenance: OutputProvenance;
  metric?: MetricValue;
}

export interface FindingRecordView extends BaseRecordView {
  kind: "finding";
  claim?: string;
  notes?: string;
  evidence: EvidenceDescriptor[];
}

export interface PriorInsightRecordView extends BaseRecordView {
  kind: "prior_insight";
  claim?: string;
  notes?: string;
  evidence: EvidenceDescriptor[];
}

export type ProjectRecordView =
  | InputRecordView
  | DecisionRecordView
  | OutputRecordView
  | FindingRecordView
  | PriorInsightRecordView;

export type ResourceKind =
  | "figure"
  | "table"
  | "metric"
  | "dataset"
  | "document"
  | "other";

export type ResourceAvailability =
  | "available"
  | "missing"
  | "stale"
  | "unknown";

export type ResourceAssociationSource =
  | "declared"
  | "materialized"
  | "inferred";

/** Serializable metadata only. Hosts keep paths, URLs, credentials, and bytes. */
export interface ResourceDescriptor {
  id: string;
  kind: ResourceKind;
  mediaType?: string;
  fileName?: string;
  byteSize?: number;
  revision?: string;
  availability: ResourceAvailability;
  source: ResourceAssociationSource;
  outputRecordId?: string;
}

export interface ProjectViewModelV1 {
  schemaVersion: typeof PROJECT_VIEW_MODEL_SCHEMA_VERSION;
  revision: ProjectRevision;
  project: ProjectIdentity;
  selection: ProjectSelection;
  scopes: ProjectScopeView[];
  records: ProjectRecordView[];
  resources: ResourceDescriptor[];
  diagnostics: ViewModelDiagnostic[];
}

/** A record reference as hosts and chat surfaces pass it around. */
export interface ProjectRecordReference {
  kind?: AstraRecordKind;
  id: string;
  canonicalPath?: string;
  /** Compatibility spelling used by the first Jupyter prototype. */
  path?: string;
}
