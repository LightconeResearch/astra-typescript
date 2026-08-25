// Project an ASTRA analysis tree into canonical `project-view-model.v1`.
//
// This is the shared projector every host runs (JupyterLab in the browser,
// VSCode in the extension host, the MyST build in Node). It projects current
// ASTRA documents directly into the host-neutral viewer contract.
//
// The projector never touches bytes beyond the YAML tree: artifact files are
// stat'ed for metadata, never read. Table previews, paper caches, and wire
// envelopes are host concerns.

import { parse as parseYaml } from "yaml";

import type {
  DirectoryEntry,
  FileStatInfo,
  ProjectFileAccess,
} from "./access.js";
import {
  basename,
  dirname,
  fileExtension,
  isExternalPath,
  joinPath,
} from "./access.js";
import type {
  AstraRecordKind,
  DecisionOptionView,
  DecisionRecordView,
  EvidenceDescriptor,
  FindingRecordView,
  InputRecordView,
  OutputRecordView,
  PriorInsightRecordView,
  ProjectRecordView,
  ProjectScopeView,
  ProjectViewModelV1,
  ProvenanceReference,
  RecordRelation,
  ResourceDescriptor,
  ViewModelDiagnostic,
} from "./types.js";
import { PROJECT_VIEW_MODEL_SCHEMA_VERSION } from "./types.js";

/** Host-side binding from a resource id to a real file the host may serve. */
export interface ArtifactBinding {
  id: string;
  recordId: string;
  recordPath: string;
  /** Project-relative path. Never forwarded to browsers directly. */
  path: string;
  mediaType: string;
  size: number;
  revision: string;
  availability: "available";
  source: "inferred";
}

export interface ProjectRevisions {
  analysis: string;
  selection: string;
  materialization: string;
}

export interface ProjectDependencies {
  analysis: string[];
  selection: string[];
  materialization: string[];
}

export interface ProjectViewBundle {
  model: ProjectViewModelV1;
  artifacts: ArtifactBinding[];
  revisions: ProjectRevisions;
  /** Combined revision suitable for ETag-style freshness checks. */
  revision: string;
  /** Project-relative files each revision digest watched. */
  dependencies: ProjectDependencies;
  /** Normalized DOIs cited by prior-insight evidence, sorted. */
  citedDois: string[];
}

export interface ProjectViewOptions {
  /** Universe id to select; defaults to the first universe file. */
  universeId?: string;
}

type Dict = Record<string, unknown>;

/** Local YAML-mapping parse so this subtree stays free of node:* imports. */
function parseYamlString(text: string): Dict {
  const data = parseYaml(text);
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("YAML root must be a mapping/object");
  }
  return data as Dict;
}

const OUTPUT_TYPES = new Set([
  "figure",
  "table",
  "metric",
  "data",
  "dataset",
  "report",
  "file",
]);

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".webp": "image/webp",
};

function asDict(value: unknown): Dict | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Dict)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function mediaTypeFor(fileName: string): string {
  return EXTENSION_MEDIA_TYPES[fileExtension(fileName)] ?? "application/octet-stream";
}

const encoder = new TextEncoder();

async function sha256Hex(chunks: Uint8Array[]): Promise<string> {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", merged);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function mtimeNsOf(stat: FileStatInfo): string {
  // Digest with millisecond precision only: the Jupyter contents API cannot
  // see nanoseconds, and revision digests must agree across viewer hosts.
  return (BigInt(Math.floor(stat.mtimeMs)) * 1_000_000n).toString();
}

/** Sort project-relative paths by path components, matching Python Path order. */
function comparePaths(a: string, b: string): number {
  const partsA = a.split("/");
  const partsB = b.split("/");
  const length = Math.min(partsA.length, partsB.length);
  for (let i = 0; i < length; i += 1) {
    const segA = partsA[i]!;
    const segB = partsB[i]!;
    if (segA < segB) return -1;
    if (segA > segB) return 1;
  }
  return partsA.length - partsB.length;
}

async function dependencyDigest(
  access: ProjectFileAccess,
  paths: Iterable<string>,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  for (const path of [...new Set(paths)].sort(comparePaths)) {
    const key = isExternalPath(path)
      ? `external:${await sha256Hex([encoder.encode(path)])}`
      : path;
    chunks.push(encoder.encode(key));
    const stat = await access.stat(path);
    if (!stat) continue;
    chunks.push(encoder.encode(`${mtimeNsOf(stat)}:${stat.size}`));
    const extension = fileExtension(path);
    if (extension === ".yaml" || extension === ".yml") {
      try {
        chunks.push(encoder.encode(await access.readText(path)));
      } catch {
        // Unreadable content degrades to metadata-only, like the reference.
      }
    }
  }
  return (await sha256Hex(chunks)).slice(0, 16);
}

async function loadYamlDict(access: ProjectFileAccess, path: string): Promise<Dict> {
  return parseYamlString(await access.readText(path));
}

interface UniverseResult {
  universe: Dict;
  path?: string;
  available: string[];
}

async function readUniverse(
  access: ProjectFileAccess,
  requested?: string,
): Promise<UniverseResult> {
  const entries = await access.listDirectory("universes");
  const files = entries
    .filter((entry) =>
      entry.type === "file" && (/\.ya?ml$/i).test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
  const available = files.map((name) => name.replace(/\.ya?ml$/i, ""));
  let selected: string | undefined;
  if (requested) {
    selected = files.find((name) => name.replace(/\.ya?ml$/i, "") === requested);
    if (!selected) {
      throw new Error(`ASTRA_UNIVERSE="${requested}" does not match any universe file`);
    }
  } else {
    selected = files[0];
  }
  if (!selected) {
    return { universe: { id: "default", decisions: {} }, available };
  }
  const path = joinPath("universes", selected);
  const universe = await loadYamlDict(access, path);
  if (universe.id === undefined) {
    universe.id = selected.replace(/\.ya?ml$/i, "");
  }
  return { universe, path, available };
}

function scopeUniverse(universe: Dict, childId: string): Dict {
  const analyses = asDict(universe.analyses);
  const fallback = { id: universe.id ?? "default", decisions: {} };
  if (!analyses) return fallback;
  const child = asDict(analyses[childId]);
  if (!child) return fallback;
  return {
    id: universe.id ?? "default",
    decisions: child.decisions ?? {},
    analyses: child.analyses ?? {},
  };
}

function recordPath(scopePath: string[], collection: string, recordId: string): string {
  return [...scopePath, collection, recordId].join(".");
}

function extractEvidence(items: unknown): Dict[] {
  if (!Array.isArray(items)) return [];
  const result: Dict[] = [];
  for (const item of items) {
    const entry = asDict(item);
    if (!entry) continue;
    const quote = asDict(entry.quote);
    const location = asDict(entry.location);
    const extracted: Dict = {};
    if (entry.artifact != null) extracted.artifact = entry.artifact;
    if (entry.doi != null) extracted.doi = entry.doi;
    if (quote?.exact != null) extracted.quote = quote.exact;
    if (location?.page != null) extracted.page = location.page;
    result.push(extracted);
  }
  return result;
}

function decisionActive(decision: Dict, selected: Dict): boolean {
  if (decision.from != null) return false;
  if (!asDict(decision.options)) return false;
  const conditions = decision.when;
  if (conditions == null) return true;
  const list = typeof conditions === "string" ? [conditions] : conditions;
  if (!Array.isArray(list)) return false;
  for (const condition of list) {
    if (typeof condition !== "string") return false;
    const dot = condition.lastIndexOf(".");
    if (dot < 0) return false;
    const decisionId = condition.slice(0, dot);
    const optionId = condition.slice(dot + 1);
    if (selected[decisionId] !== optionId) return false;
  }
  return true;
}

async function artifactFiles(
  access: ProjectFileAccess,
  directory: string,
): Promise<string[]> {
  const entries = await access.listDirectory(directory);
  return entries
    .filter((entry) => entry.type === "file" && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

async function discoverArtifact(
  access: ProjectFileAccess,
  scopeDirectory: string,
  universeId: string,
  outputId: string,
  format?: string,
): Promise<string | undefined> {
  // lightcone-cli's canonical result layout gives each output its own
  // directory. Viewers do not guess alternate locations: a missing canonical
  // directory is reported to the user instead of risking a wrong association.
  const ownDirectory = joinPath(scopeDirectory, "results", universeId, outputId);
  const own = await artifactFiles(access, ownDirectory);
  if (own.length) {
    // A declared `format` says which file in the directory is *the* artifact,
    // so a run that also wrote a log or a preview alongside it no longer
    // decides the association by sort order.
    const declared = format ? own.find((name) => name === `${outputId}.${format}`) : undefined;
    const exact = own.find((name) => name.replace(/\.[^.]*$/, "") === outputId);
    return joinPath(ownDirectory, declared ?? exact ?? own[0]!);
  }
  return undefined;
}

const KINDS_INPUT_OUTPUT = ["input", "output"] as const;
const KINDS_DECISION = ["decision"] as const;
const KINDS_OUTPUT = ["output"] as const;
const KINDS_INSIGHT = ["prior_insight"] as const;

interface PendingAlias {
  recordId: string;
  scopeId: string;
  reference: string;
  targetKinds: readonly AstraRecordKind[];
}

interface PendingEvidenceArtifact {
  recordId: string;
  scopeId: string;
  evidenceIndex: number;
  reference: string;
}

interface AuthoredOutputReferences {
  scopeId: string;
  inputs: string[];
  decisions: string[];
  alias?: string;
}

interface ProjectStructures {
  rootAnalysis: Dict;
  scopes: ProjectScopeView[];
  records: ProjectRecordView[];
  resources: ResourceDescriptor[];
  artifacts: ArtifactBinding[];
  diagnostics: ViewModelDiagnostic[];
  aliases: PendingAlias[];
  evidenceArtifacts: PendingEvidenceArtifact[];
  optionInsights: Map<string, ReadonlyMap<string, readonly string[]>>;
  outputs: Map<string, AuthoredOutputReferences>;
  universeId: string;
  universePath?: string;
  availableUniverses: string[];
  dependencies: ProjectDependencies;
}

interface ProjectionIndex {
  scopeById: ReadonlyMap<string, ProjectScopeView>;
  scopeByPath: ReadonlyMap<string, ProjectScopeView>;
  recordById: ReadonlyMap<string, ProjectRecordView>;
  recordByPath: ReadonlyMap<string, ProjectRecordView>;
  recordsByScopeAndLocalId: ReadonlyMap<string, readonly ProjectRecordView[]>;
}

function scopeId(path: readonly string[]): string {
  return path.length ? path.join(".") : "root";
}

function viewOutputType(value: unknown): OutputRecordView["outputType"] {
  if (value === "data") return "dataset";
  return typeof value === "string" && OUTPUT_TYPES.has(value)
    ? value as OutputRecordView["outputType"]
    : "other";
}

function resourceKind(value: unknown): ResourceDescriptor["kind"] {
  const normalized = viewOutputType(value);
  if (normalized === "report") return "document";
  if (normalized === "file") return "other";
  if (
    normalized === "dataset"
    || normalized === "figure"
    || normalized === "table"
    || normalized === "metric"
  ) {
    return normalized;
  }
  return "other";
}

function modelRecordId(
  ownerScopeId: string,
  kind: AstraRecordKind,
  localId: string,
): string {
  return `${ownerScopeId}:${kind}:${localId}`;
}

function addRelation(
  record: ProjectRecordView,
  relation: RecordRelation,
): void {
  const existing = record.relations.find(
    (candidate) =>
      candidate.kind === relation.kind
      && candidate.targetRecordId === relation.targetRecordId,
  );
  if (!existing) {
    record.relations.push(relation);
  } else if (existing.direct === false && relation.direct !== false) {
    existing.direct = relation.direct;
  }
}

function createProjectionIndex(structures: ProjectStructures): ProjectionIndex {
  const scopeById = new Map(structures.scopes.map((scope) => [scope.id, scope]));
  const scopeByPath = new Map(
    structures.scopes.map((scope) => [scope.canonicalPath, scope]),
  );
  const recordById = new Map(structures.records.map((record) => [record.id, record]));
  const recordByPath = new Map(
    structures.records.map((record) => [record.canonicalPath, record]),
  );
  const recordsByScopeAndLocalId = new Map<string, ProjectRecordView[]>();
  for (const record of structures.records) {
    const key = `${record.scopeId}\0${record.localId}`;
    const matches = recordsByScopeAndLocalId.get(key) ?? [];
    matches.push(record);
    recordsByScopeAndLocalId.set(key, matches);
  }
  return {
    scopeById,
    scopeByPath,
    recordById,
    recordByPath,
    recordsByScopeAndLocalId,
  };
}

function resolveReference(
  index: ProjectionIndex,
  sourceScopeId: string,
  rawReference: string,
  targetKinds: readonly AstraRecordKind[],
): ProjectRecordView | undefined {
  let reference = rawReference.trim();
  if (!reference) return undefined;

  const exact = index.recordByPath.get(reference);
  if (exact && targetKinds.includes(exact.kind)) return exact;

  let owner = index.scopeById.get(sourceScopeId);
  while (reference.startsWith("../")) {
    if (!owner?.parentId) return undefined;
    owner = index.scopeById.get(owner.parentId);
    reference = reference.slice(3);
  }
  if (reference.startsWith("./")) reference = reference.slice(2);
  if (!owner || !reference) return undefined;

  const segments = reference.split(".").filter(Boolean);
  if (segments.length > 1) {
    const qualifiedScopePath = segments.slice(0, -1).join(".");
    const qualifiedScope = index.scopeByPath.get(qualifiedScopePath)
      ?? index.scopeById.get(qualifiedScopePath);
    if (qualifiedScope) {
      const key = `${qualifiedScope.id}\0${segments[segments.length - 1]}`;
      const matches = (index.recordsByScopeAndLocalId.get(key) ?? [])
        .filter((record) => targetKinds.includes(record.kind));
      return matches.length === 1 ? matches[0] : undefined;
    }
  }

  while (owner) {
    const prefix = owner.canonicalPath === "root" ? "" : `${owner.canonicalPath}.`;
    const relative = index.recordByPath.get(`${prefix}${reference}`);
    if (relative && targetKinds.includes(relative.kind)) return relative;

    const localId = segments[segments.length - 1] ?? reference;
    const key = `${owner.id}\0${localId}`;
    const matches = (index.recordsByScopeAndLocalId.get(key) ?? [])
      .filter((record) => targetKinds.includes(record.kind));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
    owner = owner.parentId ? index.scopeById.get(owner.parentId) : undefined;
  }
  return undefined;
}

function recipeDescriptor(value: unknown): OutputRecordView["recipe"] {
  const recipe = asDict(value);
  if (!recipe) return undefined;
  const command = asString(recipe.command);
  const container = asString(recipe.container);
  return command || container ? { command, container } : undefined;
}

function metricDescriptor(value: unknown): OutputRecordView["metric"] {
  const metric = asDict(value);
  if (!metric) return undefined;
  const result: NonNullable<OutputRecordView["metric"]> = {};
  if (typeof metric.value === "string" || typeof metric.value === "number") {
    result.value = metric.value;
  }
  if (typeof metric.uncertainty === "string" || typeof metric.uncertainty === "number") {
    result.uncertainty = metric.uncertainty;
  }
  if (typeof metric.unit === "string") result.unit = metric.unit;
  if (typeof metric.label === "string") result.label = metric.label;
  return Object.keys(result).length ? result : undefined;
}

async function loadProjectStructures(
  access: ProjectFileAccess,
  options: ProjectViewOptions,
): Promise<ProjectStructures> {
  const rootStat = await access.stat("astra.yaml");
  if (!rootStat) throw new Error("No astra.yaml found in the project root");

  const rootAnalysis = await loadYamlDict(access, "astra.yaml");
  const { universe, path: universePath, available } = await readUniverse(
    access,
    options.universeId,
  );
  const universeId = String(universe.id ?? "default");
  const scopes: ProjectScopeView[] = [];
  const records: ProjectRecordView[] = [];
  const resources: ResourceDescriptor[] = [];
  const artifacts: ArtifactBinding[] = [];
  const diagnostics: ViewModelDiagnostic[] = [];
  const aliases: PendingAlias[] = [];
  const evidenceArtifacts: PendingEvidenceArtifact[] = [];
  const optionInsights = new Map<string, ReadonlyMap<string, readonly string[]>>();
  const outputs = new Map<string, AuthoredOutputReferences>();
  const dependencies: ProjectDependencies = {
    analysis: ["astra.yaml"],
    selection: universePath ? [universePath] : [],
    materialization: [],
  };

  const visit = async (
    analysis: Dict,
    directory: string,
    path: string[],
    activeUniverse: Dict,
    parentId?: string,
  ): Promise<void> => {
    const ownerScopeId = scopeId(path);
    const ownerScopePath = path.length ? path.join(".") : "root";
    const astraVersion = asString(analysis.version);
    if (astraVersion && astraVersion !== "1.0" && astraVersion !== "1.0.0") {
      throw new Error(
        `Unsupported ASTRA version "${astraVersion}" at ${ownerScopePath}; expected 1.0 or 1.0.0.`,
      );
    }
    if ("authors" in analysis) {
      throw new Error(
        `Unsupported ASTRA field "authors" at ${ownerScopePath}; publication authorship belongs in publication metadata.`,
      );
    }

    const childRefs = asDict(analysis.analyses) ?? {};
    const scope: ProjectScopeView = {
      id: ownerScopeId,
      canonicalPath: ownerScopePath,
      name: String(
        path.length
          ? (analysis.name ?? analysis.id ?? path[path.length - 1])
          : (analysis.name ?? analysis.id ?? "ASTRA analysis"),
      ),
      ...(typeof analysis.description === "string"
        ? { description: analysis.description }
        : {}),
      ...(parentId ? { parentId } : {}),
      childIds: Object.keys(childRefs).map((childId) => scopeId([...path, childId])),
      recordIds: [],
    };
    scopes.push(scope);

    const addRecord = (record: ProjectRecordView): void => {
      records.push(record);
      scope.recordIds.push(record.id);
    };

    for (const rawInput of Array.isArray(analysis.inputs) ? analysis.inputs : []) {
      const input = asDict(rawInput);
      const localId = asString(input?.id);
      if (!input || !localId) continue;
      const id = modelRecordId(ownerScopeId, "input", localId);
      const record: InputRecordView = {
        id,
        localId,
        canonicalPath: recordPath(path, "inputs", localId),
        scopeId: ownerScopeId,
        kind: "input",
        ...(typeof input.label === "string" ? { label: input.label } : {}),
        ...(typeof input.description === "string"
          ? { description: input.description }
          : {}),
        ...(typeof input.type === "string" ? { inputType: input.type } : {}),
        ...(typeof input.source === "string" ? { source: input.source } : {}),
        ...(typeof input.ref === "string" ? { reference: input.ref } : {}),
        relations: [],
      };
      addRecord(record);
      if (typeof input.from === "string") {
        aliases.push({
          recordId: id,
          scopeId: ownerScopeId,
          reference: input.from,
          targetKinds: KINDS_INPUT_OUTPUT,
        });
      }
    }

    const selected = asDict(activeUniverse.decisions) ?? {};
    for (const [localId, rawDecision] of Object.entries(asDict(analysis.decisions) ?? {})) {
      const decision = asDict(rawDecision);
      if (!decision) continue;
      const id = modelRecordId(ownerScopeId, "decision", localId);
      const active = decisionActive(decision, selected);
      const selectedOption = active
        ? asString(selected[localId] ?? decision.default)
        : undefined;
      const authoredOptions = asDict(decision.options) ?? {};
      const options: DecisionOptionView[] = [];
      const insightsByOption = new Map<string, readonly string[]>();
      for (const [optionId, rawOption] of Object.entries(authoredOptions)) {
        const option = asDict(rawOption) ?? {};
        const insightReferences = asStringArray(option.insights);
        if (insightReferences.length) insightsByOption.set(optionId, insightReferences);
        options.push({
          id: optionId,
          ...(typeof option.label === "string" ? { label: option.label } : {}),
          ...(typeof option.description === "string"
            ? { description: option.description }
            : {}),
          selected: optionId === selectedOption,
          ...(typeof option.excluded === "boolean" ? { excluded: option.excluded } : {}),
          ...(typeof option.excluded_reason === "string"
            ? { exclusionReason: option.excluded_reason }
            : {}),
        });
      }
      const record: DecisionRecordView = {
        id,
        localId,
        canonicalPath: recordPath(path, "decisions", localId),
        scopeId: ownerScopeId,
        kind: "decision",
        ...(typeof decision.label === "string" ? { label: decision.label } : {}),
        ...(typeof decision.rationale === "string"
          ? { rationale: decision.rationale }
          : {}),
        ...(selectedOption ? { selectedOptionId: selectedOption } : {}),
        ...(Array.isArray(decision.tags) ? { tags: asStringArray(decision.tags) } : {}),
        active,
        options,
        relations: [],
      };
      addRecord(record);
      if (insightsByOption.size) optionInsights.set(id, insightsByOption);
      if (typeof decision.from === "string") {
        aliases.push({
          recordId: id,
          scopeId: ownerScopeId,
          reference: decision.from,
          targetKinds: KINDS_DECISION,
        });
      }
    }

    for (const rawOutput of Array.isArray(analysis.outputs) ? analysis.outputs : []) {
      const output = asDict(rawOutput);
      const localId = asString(output?.id);
      if (!output || !localId) continue;
      const id = modelRecordId(ownerScopeId, "output", localId);
      const canonicalPath = recordPath(path, "outputs", localId);
      const declaredFormat = asString(output.format);
      const artifactPath = await discoverArtifact(
        access,
        directory,
        universeId,
        localId,
        declaredFormat,
      );
      const artifact = artifactPath && !isExternalPath(artifactPath)
        ? artifactPath
        : undefined;
      const resourceId = artifact
        ? `resource:${ownerScopeId}:output:${localId}`
        : undefined;
      const recipe = recipeDescriptor(output.recipe);
      const metric = metricDescriptor(output.metric);
      const record: OutputRecordView = {
        id,
        localId,
        canonicalPath,
        scopeId: ownerScopeId,
        kind: "output",
        ...(typeof output.label === "string" ? { label: output.label } : {}),
        ...(typeof output.description === "string"
          ? { description: output.description }
          : {}),
        outputType: viewOutputType(output.type),
        ...(declaredFormat ? { format: declaredFormat } : {}),
        ...(recipe ? { recipe } : {}),
        resourceIds: resourceId ? [resourceId] : [],
        provenance: { inputs: [], decisions: [] },
        ...(metric ? { metric } : {}),
        relations: [],
      };
      addRecord(record);
      if (!artifact && metric?.value === undefined) {
        const expectedDirectory = joinPath(
          directory,
          "results",
          universeId,
          localId,
        );
        diagnostics.push({
          severity: "info",
          code: "missing_expected_result",
          message:
            `No materialized result was found. Expected it at ${expectedDirectory}/. `
            + "Place or materialize the result there, then refresh.",
          canonicalPath,
        });
      }
      const alias = asString(output.from);
      outputs.set(id, {
        scopeId: ownerScopeId,
        inputs: asStringArray(output.inputs),
        decisions: asStringArray(output.decisions),
        ...(alias ? { alias } : {}),
      });
      if (alias) {
        aliases.push({
          recordId: id,
          scopeId: ownerScopeId,
          reference: alias,
          targetKinds: KINDS_OUTPUT,
        });
      }
      if (artifact && resourceId) {
        const stat = await access.stat(artifact);
        if (stat) {
          const revision = (await sha256Hex([
            encoder.encode(`${artifact}:${mtimeNsOf(stat)}:${stat.size}`),
          ])).slice(0, 16);
          const mediaType = mediaTypeFor(artifact);
          artifacts.push({
            id: resourceId,
            recordId: id,
            recordPath: canonicalPath,
            path: artifact,
            mediaType,
            size: stat.size,
            revision,
            availability: "available",
            source: "inferred",
          });
          resources.push({
            id: resourceId,
            kind: resourceKind(output.type),
            mediaType,
            fileName: basename(artifact),
            byteSize: stat.size,
            revision,
            availability: "available",
            source: "inferred",
            outputRecordId: id,
          });
          dependencies.materialization.push(artifact);
        }
      }
    }

    for (const [collection, kind] of [
      ["findings", "finding"],
      ["prior_insights", "prior_insight"],
    ] as const) {
      for (const [localId, rawInsight] of Object.entries(asDict(analysis[collection]) ?? {})) {
        const insight = asDict(rawInsight);
        if (!insight) continue;
        const id = modelRecordId(ownerScopeId, kind, localId);
        const evidence: EvidenceDescriptor[] = [];
        for (const rawEvidence of extractEvidence(insight.evidence)) {
          const descriptor: EvidenceDescriptor = {
            ...(typeof rawEvidence.doi === "string" ? { doi: rawEvidence.doi } : {}),
            ...(typeof rawEvidence.quote === "string" ? { quote: rawEvidence.quote } : {}),
            ...(typeof rawEvidence.page === "number" ? { page: rawEvidence.page } : {}),
          };
          const evidenceIndex = evidence.push(descriptor) - 1;
          if (typeof rawEvidence.artifact === "string") {
            evidenceArtifacts.push({
              recordId: id,
              scopeId: ownerScopeId,
              evidenceIndex,
              reference: rawEvidence.artifact,
            });
          }
        }
        const common = {
          id,
          localId,
          canonicalPath: recordPath(path, collection, localId),
          scopeId: ownerScopeId,
          ...(typeof insight.label === "string" ? { label: insight.label } : {}),
          ...(typeof insight.claim === "string" ? { claim: insight.claim } : {}),
          ...(typeof insight.notes === "string" ? { notes: insight.notes } : {}),
          ...(Array.isArray(insight.tags) ? { tags: asStringArray(insight.tags) } : {}),
          evidence,
          relations: [],
        };
        const record: FindingRecordView | PriorInsightRecordView = kind === "finding"
          ? { ...common, kind: "finding" }
          : { ...common, kind: "prior_insight" };
        addRecord(record);
      }
    }

    for (const [childId, rawReference] of Object.entries(childRefs)) {
      const reference = asDict(rawReference);
      if (!reference) continue;
      let child = reference;
      let childDirectory = directory;
      const declaredPath = asString(reference.path);
      if (declaredPath) {
        let location = joinPath(directory, declaredPath);
        const stat = await access.stat(location);
        if (stat?.type === "directory") location = joinPath(location, "astra.yaml");
        child = await loadYamlDict(access, location);
        for (const [key, value] of Object.entries(reference)) {
          if (key !== "path") child[key] = value;
        }
        childDirectory = dirname(location);
        dependencies.analysis.push(location);
      }
      await visit(
        child,
        childDirectory,
        [...path, childId],
        scopeUniverse(activeUniverse, childId),
        ownerScopeId,
      );
    }
  };

  await visit(rootAnalysis, "", [], universe);
  return {
    rootAnalysis,
    scopes,
    records,
    resources,
    artifacts,
    diagnostics,
    aliases,
    evidenceArtifacts,
    optionInsights,
    outputs,
    universeId,
    ...(universePath ? { universePath } : {}),
    availableUniverses: available,
    dependencies,
  };
}

function addUnresolvedDiagnostic(
  structures: ProjectStructures,
  record: ProjectRecordView,
  relationKind: string,
  reference: string,
): void {
  structures.diagnostics.push({
    severity: "warning",
    code: "unresolved_relation",
    message:
      `Could not uniquely resolve ${relationKind} reference `
      + `"${reference}" from ${record.canonicalPath}.`,
    canonicalPath: record.canonicalPath,
  });
}

function resolveCanonicalReferences(structures: ProjectStructures): ProjectionIndex {
  const index = createProjectionIndex(structures);

  for (const alias of structures.aliases) {
    const record = index.recordById.get(alias.recordId);
    if (!record) continue;
    const target = resolveReference(
      index,
      alias.scopeId,
      alias.reference,
      alias.targetKinds,
    );
    if (target) {
      addRelation(record, {
        kind: "aliases",
        targetRecordId: target.id,
        direct: true,
      });
    } else {
      addUnresolvedDiagnostic(structures, record, "aliases", alias.reference);
    }
  }

  for (const pending of structures.evidenceArtifacts) {
    const record = index.recordById.get(pending.recordId);
    if (!record || (record.kind !== "finding" && record.kind !== "prior_insight")) {
      continue;
    }
    const target = resolveReference(
      index,
      pending.scopeId,
      pending.reference,
      KINDS_OUTPUT,
    );
    if (target) {
      const evidence = record.evidence[pending.evidenceIndex];
      if (evidence) evidence.artifactRecordId = target.id;
      addRelation(record, {
        kind: "evidenced_by",
        targetRecordId: target.id,
        direct: true,
      });
    } else {
      addUnresolvedDiagnostic(structures, record, "evidenced_by", pending.reference);
    }
  }

  for (const [recordId, insightsByOption] of structures.optionInsights) {
    const record = index.recordById.get(recordId);
    if (record?.kind !== "decision") continue;
    for (const option of record.options) {
      const references = insightsByOption.get(option.id) ?? [];
      const resolved: string[] = [];
      for (const reference of references) {
        const insight = resolveReference(index, record.scopeId, reference, KINDS_INSIGHT);
        if (insight) {
          resolved.push(insight.id);
          addRelation(record, {
            kind: "informed_by",
            targetRecordId: insight.id,
            direct: true,
          });
        } else {
          structures.diagnostics.push({
            severity: "warning",
            code: "unresolved_option_insight",
            message:
              `Could not uniquely resolve option insight `
              + `"${reference}" from ${record.canonicalPath}.`,
            canonicalPath: record.canonicalPath,
          });
        }
      }
      if (resolved.length) option.insightRecordIds = resolved;
    }
  }

  return index;
}

function selectedOptionLabel(record: DecisionRecordView): string | undefined {
  const selected = record.options.find((option) => option.id === record.selectedOptionId);
  return selected?.label ?? record.selectedOptionId;
}

function aliasedTarget(
  index: ProjectionIndex,
  record: ProjectRecordView,
): ProjectRecordView {
  const seen = new Set<string>();
  let current = record;
  while (!seen.has(current.id)) {
    seen.add(current.id);
    const relation = current.relations.find((candidate) => candidate.kind === "aliases");
    const target = relation ? index.recordById.get(relation.targetRecordId) : undefined;
    if (!target) break;
    current = target;
  }
  return current;
}

function traceOutputProvenance(
  structures: ProjectStructures,
  index: ProjectionIndex,
  output: OutputRecordView,
): { inputs: ProvenanceReference[]; decisions: ProvenanceReference[] } {
  const roots = new Map<string, ProvenanceReference>();
  const decisions = new Map<string, ProvenanceReference>();
  const seen = new Set<string>();

  const addDecision = (record: DecisionRecordView): void => {
    const target = aliasedTarget(index, record);
    if (target.kind !== "decision") return;
    const entry: ProvenanceReference = {
      reference: target.localId,
      recordId: target.id,
      ...(target.label ? { label: target.label } : {}),
      ...(target.scopeId !== output.scopeId ? { scopeId: target.scopeId } : {}),
      ...(selectedOptionLabel(target) ? { selection: selectedOptionLabel(target) } : {}),
      direct: false,
    };
    const previous = decisions.get(target.id);
    if (!previous || (previous.scopeId && !entry.scopeId)) decisions.set(target.id, entry);
  };

  const addRoot = (record: ProjectRecordView | undefined, reference: string): void => {
    const target = record ? aliasedTarget(index, record) : undefined;
    if (target?.kind === "output") {
      trace(target);
      return;
    }
    const key = target?.id ?? reference;
    if (!roots.has(key)) {
      roots.set(key, {
        reference: target?.localId ?? reference,
        ...(target ? { recordId: target.id } : {}),
        ...(target?.label ? { label: target.label } : {}),
        direct: false,
      });
    }
  };

  const trace = (current: OutputRecordView): void => {
    if (seen.has(current.id)) return;
    seen.add(current.id);
    const authored = structures.outputs.get(current.id);
    if (!authored) return;
    if (authored.alias) {
      const target = resolveReference(index, authored.scopeId, authored.alias, KINDS_OUTPUT);
      if (target?.kind === "output") trace(target);
      return;
    }
    for (const reference of authored.decisions) {
      const decision = resolveReference(index, authored.scopeId, reference, KINDS_DECISION);
      if (decision?.kind === "decision") addDecision(decision);
    }
    for (const reference of authored.inputs) {
      const input = resolveReference(index, authored.scopeId, reference, KINDS_INPUT_OUTPUT);
      if (input?.kind === "output") trace(input);
      else addRoot(input, reference);
    }
  };

  trace(output);
  return { inputs: [...roots.values()], decisions: [...decisions.values()] };
}

/** Give every re-export the format of the output it stands for.
 *
 * The schema forbids `format` on an alias, so an alias that reported only
 * what it declared would always report nothing — leaving a viewer holding a
 * re-export unable to say what it is about to open. Runs after aliases are
 * resolved, so the chain is walkable.
 */
function attachAliasedFormats(
  structures: ProjectStructures,
  index: ProjectionIndex,
): void {
  for (const record of structures.records) {
    if (record.kind !== "output" || record.format) continue;
    const target = aliasedTarget(index, record);
    if (target.id === record.id || target.kind !== "output") continue;
    if (target.format) record.format = target.format;
  }
}

function attachOutputProvenance(
  structures: ProjectStructures,
  index: ProjectionIndex,
): void {
  for (const record of structures.records) {
    if (record.kind !== "output") continue;
    const authored = structures.outputs.get(record.id);
    if (!authored) continue;
    const directInputs: ProvenanceReference[] = authored.inputs.map((reference) => {
      const target = resolveReference(index, authored.scopeId, reference, KINDS_INPUT_OUTPUT);
      if (!target) addUnresolvedDiagnostic(structures, record, "depends_on", reference);
      return {
        reference,
        ...(target ? { recordId: target.id } : {}),
        direct: true,
      };
    });
    const directDecisions: ProvenanceReference[] = authored.decisions.map((reference) => {
      const target = resolveReference(index, authored.scopeId, reference, KINDS_DECISION);
      if (!target) addUnresolvedDiagnostic(structures, record, "parameterized_by", reference);
      const decision = target?.kind === "decision" ? target : undefined;
      return {
        reference,
        ...(decision ? { recordId: decision.id } : {}),
        ...(decision?.label ? { label: decision.label } : {}),
        ...(decision && selectedOptionLabel(decision)
          ? { selection: selectedOptionLabel(decision) }
          : {}),
        direct: true,
      };
    });
    const transitive = traceOutputProvenance(structures, index, record);
    const directInputIds = new Set(directInputs.flatMap((entry) => entry.recordId ?? []));
    const directDecisionIds = new Set(
      directDecisions.flatMap((entry) => entry.recordId ?? []),
    );
    record.provenance = {
      inputs: [
        ...directInputs,
        ...transitive.inputs.filter(
          (entry) => !entry.recordId || !directInputIds.has(entry.recordId),
        ),
      ],
      decisions: [
        ...directDecisions,
        ...transitive.decisions.filter(
          (entry) => !entry.recordId || !directDecisionIds.has(entry.recordId),
        ),
      ],
    };
    for (const entry of record.provenance.inputs) {
      if (entry.recordId) {
        addRelation(record, {
          kind: "depends_on",
          targetRecordId: entry.recordId,
          direct: entry.direct,
        });
      }
    }
    for (const entry of record.provenance.decisions) {
      if (entry.recordId) {
        addRelation(record, {
          kind: "parameterized_by",
          targetRecordId: entry.recordId,
          direct: entry.direct,
        });
      }
    }
  }
}

function createProjectModel(
  structures: ProjectStructures,
  revisions: ProjectRevisions,
): ProjectViewModelV1 {
  const index = resolveCanonicalReferences(structures);
  attachAliasedFormats(structures, index);
  attachOutputProvenance(structures, index);
  const selectedDecisions = Object.fromEntries(
    structures.records.flatMap((record) =>
      record.kind === "decision" && record.selectedOptionId
        ? [[record.id, record.selectedOptionId]]
        : [],
    ),
  );
  return {
    schemaVersion: PROJECT_VIEW_MODEL_SCHEMA_VERSION,
    revision: {
      analysis: revisions.analysis,
      ...(structures.universePath ? { selection: revisions.selection } : {}),
    },
    project: {
      id: String(structures.rootAnalysis.id ?? "root"),
      name: String(
        structures.rootAnalysis.name
        ?? structures.rootAnalysis.id
        ?? "ASTRA analysis",
      ),
      ...(typeof structures.rootAnalysis.description === "string"
        ? { description: structures.rootAnalysis.description }
        : {}),
      ...(typeof structures.rootAnalysis.version === "string"
        ? { astraVersion: structures.rootAnalysis.version }
        : {}),
    },
    selection: {
      universeId: structures.universeId,
      availableUniverses: structures.availableUniverses,
      decisions: selectedDecisions,
      source: structures.universePath ? "explicit" : "default",
    },
    scopes: structures.scopes,
    records: structures.records,
    resources: structures.resources,
    diagnostics: structures.diagnostics,
  };
}

function collectCitedDois(records: readonly ProjectRecordView[]): string[] {
  const normalize = (value: string): string => {
    let normalized = value.trim();
    for (const prefix of ["https://doi.org/", "http://doi.org/", "doi:"]) {
      if (normalized.toLowerCase().startsWith(prefix)) {
        normalized = normalized.slice(prefix.length);
        break;
      }
    }
    return normalized.trim().toLowerCase();
  };
  const dois = new Set<string>();
  for (const record of records) {
    if (record.kind !== "prior_insight") continue;
    for (const evidence of record.evidence) {
      if (evidence.doi) dois.add(normalize(evidence.doi));
    }
  }
  return [...dois].sort();
}

/**
 * Project one ASTRA project into the canonical view model plus the host-side
 * bindings needed to serve it.
 */
export async function buildProjectViewModel(
  access: ProjectFileAccess,
  options: ProjectViewOptions = {},
): Promise<ProjectViewBundle> {
  const structures = await loadProjectStructures(access, options);
  const revisions: ProjectRevisions = {
    analysis: await dependencyDigest(access, structures.dependencies.analysis),
    selection: await dependencyDigest(access, structures.dependencies.selection),
    materialization: await dependencyDigest(access, structures.dependencies.materialization),
  };
  const revision = (await sha256Hex([
    encoder.encode(
      `${revisions.analysis}:${revisions.selection}:${revisions.materialization}`,
    ),
  ])).slice(0, 16);

  const model = createProjectModel(structures, revisions);

  const bundle: ProjectViewBundle = {
    model,
    artifacts: structures.artifacts,
    revisions,
    revision,
    dependencies: structures.dependencies,
    citedDois: collectCitedDois(structures.records),
  };
  return bundle;
}
