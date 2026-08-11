// Project an ASTRA analysis tree into canonical `project-view-model.v1`.
//
// This is the shared projector every host runs (JupyterLab in the browser,
// VSCode in the extension host, the MyST build in Node). It is a faithful
// port of the reference implementation that shipped in jupyterlab-astra
// (`loader.py` + `projector.py`), validated byte-for-byte against it on the
// DESI DR1 BAO project. Diagnostic codes keep their historical spellings so
// downstream consumers are unaffected.
//
// The projector never touches bytes beyond the YAML tree: artifact files are
// stat'ed for metadata, never read. Table previews, paper caches, and wire
// envelopes are host concerns.

import { parseYamlString } from "../helpers.js";
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
  ProjectViewModelV1,
  ResourceDescriptor,
  ViewModelDiagnostic,
} from "./types.js";
import { PROJECT_VIEW_MODEL_SCHEMA_VERSION } from "./types.js";

export const GRAPH_ORGANIZATION_PATH = ".astra/astra.graph.yaml";
export const LEGACY_GRAPH_ORGANIZATION_PATH = "astra.graph.yaml";

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
  organization: string;
}

export interface ProjectDependencies {
  analysis: string[];
  selection: string[];
  materialization: string[];
  organization: string[];
}

export interface ProjectViewBundle {
  model: ProjectViewModelV1;
  artifacts: ArtifactBinding[];
  revisions: ProjectRevisions;
  /** Combined revision suitable for ETag-style freshness checks. */
  revision: string;
  /** Raw astra.graph.yaml value (or `{load_error}` marker), when present. */
  graphOrganization?: unknown;
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

interface LegacyRecord {
  [key: string]: unknown;
  id: string;
  path: string;
  kind: "input" | "decision" | "output" | "finding" | "prior_insight";
}

interface LegacyScope {
  id: string;
  path: string;
  name: string;
  parent: string | null;
  children: string[];
  records: LegacyRecord[];
}

const OUTPUT_TYPES = new Set([
  "figure",
  "table",
  "metric",
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

const FIGURE_SUFFIXES = new Set([".gif", ".jpeg", ".jpg", ".pdf", ".png", ".svg", ".webp"]);
const METRIC_SUFFIXES = new Set([".csv", ".json", ".txt", ".tsv", ".yaml", ".yml"]);
const TABLE_SUFFIXES = new Set([".csv", ".json", ".parquet", ".tsv"]);

function asDict(value: unknown): Dict | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Dict)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
  if (stat.mtimeNs !== undefined) return stat.mtimeNs.toString();
  return BigInt(Math.round(stat.mtimeMs * 1e6)).toString();
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

interface GraphOrganizationResult {
  value: unknown;
  path?: string;
  diagnostic?: Dict;
}

async function readGraphOrganization(
  access: ProjectFileAccess,
): Promise<GraphOrganizationResult> {
  let found: string | undefined;
  for (const relative of [GRAPH_ORGANIZATION_PATH, LEGACY_GRAPH_ORGANIZATION_PATH]) {
    const stat = await access.stat(relative);
    if (stat?.type === "file") {
      found = relative;
      break;
    }
  }
  if (!found) return { value: undefined };
  let parsed: unknown;
  try {
    parsed = parseYamlString(await access.readText(found));
  } catch (error) {
    return {
      value: { load_error: String(error instanceof Error ? error.message : error) },
      path: found,
      diagnostic: {
        severity: "warning",
        code: "graph.organization.unreadable",
        path: found,
        message:
          "The graph organization file could not be read. "
          + "The complete canonical graph remains available.",
      },
    };
  }
  if (!asDict(parsed)) {
    return {
      value: { load_error: "astra.graph.yaml is not a mapping" },
      path: found,
      diagnostic: {
        severity: "warning",
        code: "graph.organization.not_mapping",
        path: found,
        message:
          "The graph organization file must contain a YAML mapping. "
          + "The complete canonical graph remains available.",
      },
    };
  }
  return { value: parsed, path: found };
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

function firstEvidenceValue(evidence: Dict[], key: string): unknown {
  for (const item of evidence) {
    if (item[key] != null) return item[key];
  }
  return undefined;
}

function optionInsights(options: Dict): Record<string, string[]> | undefined {
  const result: Record<string, string[]> = {};
  for (const [optionId, option] of Object.entries(options)) {
    const entry = asDict(option);
    if (!entry) continue;
    const insights = entry.insights;
    if (Array.isArray(insights)) {
      const values = insights.filter((value): value is string => typeof value === "string");
      if (values.length) result[optionId] = values;
    }
  }
  return Object.keys(result).length ? result : undefined;
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
  outputType: string,
): Promise<string | undefined> {
  // lightcone-cli's result layout gives each output its own directory.
  const ownDirectory = joinPath(scopeDirectory, "results", universeId, outputId);
  const own = await artifactFiles(access, ownDirectory);
  if (own.length) {
    const exact = own.find((name) => name.replace(/\.[^.]*$/, "") === outputId);
    return joinPath(ownDirectory, exact ?? own[0]!);
  }

  // Some existing projects materialize a universe into one flat outputs
  // directory. Prefer exact names, then a unique file matching the declared
  // output type, then unambiguous token overlap.
  const flatDirectory = joinPath(scopeDirectory, "outputs", universeId);
  const flat = await artifactFiles(access, flatDirectory);
  if (!flat.length) return undefined;
  const exact = flat.find((name) => name.replace(/\.[^.]*$/, "") === outputId);
  if (exact) return joinPath(flatDirectory, exact);

  const suffixes = { figure: FIGURE_SUFFIXES, metric: METRIC_SUFFIXES, table: TABLE_SUFFIXES }[
    outputType.toLowerCase() as "figure" | "metric" | "table"
  ];
  const candidates = suffixes
    ? flat.filter((name) => suffixes.has(fileExtension(name)))
    : flat;
  if (candidates.length === 1) return joinPath(flatDirectory, candidates[0]!);

  const outputTokens = new Set(outputId.toLowerCase().replace(/-/g, "_").split("_"));
  const scored = candidates
    .map((name) => {
      const stem = name.replace(/\.[^.]*$/, "");
      const tokens = new Set(stem.toLowerCase().replace(/-/g, "_").split("_"));
      let overlap = 0;
      for (const token of outputTokens) if (tokens.has(token)) overlap += 1;
      return { overlap, name };
    })
    .sort((a, b) => a.overlap - b.overlap || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const top = scored[scored.length - 1];
  if (!top || top.overlap === 0) return undefined;
  if (scored.length > 1 && scored[scored.length - 2]!.overlap === top.overlap) {
    return undefined;
  }
  return joinPath(flatDirectory, top.name);
}

interface LoadedStructures {
  rootAnalysis: Dict;
  scopes: LegacyScope[];
  artifacts: ArtifactBinding[];
  diagnostics: Dict[];
  universeId: string;
  availableUniverses: string[];
  graphOrganization: GraphOrganizationResult;
  dependencies: ProjectDependencies;
}

async function loadStructures(
  access: ProjectFileAccess,
  options: ProjectViewOptions,
): Promise<LoadedStructures> {
  const rootStat = await access.stat("astra.yaml");
  if (!rootStat) {
    throw new Error("No astra.yaml found in the project root");
  }
  const rootAnalysis = await loadYamlDict(access, "astra.yaml");
  const graphOrganization = await readGraphOrganization(access);
  const { universe, path: universePath, available } = await readUniverse(
    access,
    options.universeId,
  );
  const universeId = String(universe.id ?? "default");

  const scopes: LegacyScope[] = [];
  const artifacts: ArtifactBinding[] = [];
  const diagnostics: Dict[] = [];
  if (graphOrganization.diagnostic) diagnostics.push(graphOrganization.diagnostic);

  const dependencies: ProjectDependencies = {
    analysis: ["astra.yaml"],
    selection: universePath ? [universePath] : [],
    materialization: [],
    organization: graphOrganization.path ? [graphOrganization.path] : [],
  };

  const visit = async (
    analysis: Dict,
    directory: string,
    path: string[],
    activeUniverse: Dict,
    parent: string | null,
  ): Promise<void> => {
    const scopeId = path.join(".");
    const astraVersion = analysis.version;
    if (typeof astraVersion === "string" && !astraVersion.startsWith("0.0.")) {
      diagnostics.push({
        severity: "warning",
        code: "astra.version.compatibility",
        path: scopeId,
        message:
          `ASTRA version "${astraVersion}" is outside this viewer's `
          + "tested 0.0.x compatibility range. The project is shown "
          + "through the compatibility projector; validate it with a "
          + "matching astra-tools release.",
      });
    }
    if ("authors" in analysis) {
      diagnostics.push({
        severity: "warning",
        code: "astra.field.unprojected",
        path: scopeId,
        message:
          'The "authors" field is not part of the current ASTRA '
          + "viewer projection and is ignored. Publication authorship "
          + "belongs in the external publication metadata.",
      });
    }
    const childRefs = asDict(analysis.analyses) ?? {};
    const childIds = Object.keys(childRefs).map((childId) => [...path, childId].join("."));
    const records: LegacyRecord[] = [];

    const inputs = analysis.inputs;
    if (Array.isArray(inputs)) {
      for (const item of inputs) {
        const entry = asDict(item);
        if (!entry || typeof entry.id !== "string") continue;
        const record: LegacyRecord = {
          id: entry.id,
          path: recordPath(path, "inputs", entry.id),
          kind: "input",
        };
        if (entry.type != null) record.type = entry.type;
        if (entry.label != null) record.label = entry.label;
        if (entry.description != null) record.description = entry.description;
        if (entry.source != null) record.source = entry.source;
        if (entry.from != null) record.from = entry.from;
        records.push(record);
      }
    }

    const decisions = asDict(analysis.decisions);
    const selected = asDict(activeUniverse.decisions) ?? {};
    if (decisions) {
      for (const [decisionId, rawItem] of Object.entries(decisions)) {
        const item = asDict(rawItem);
        if (!item) continue;
        const options = asDict(item.options) ?? {};
        const insights = optionInsights(options);
        const active = decisionActive(item, selected);
        const record: LegacyRecord = {
          id: decisionId,
          path: recordPath(path, "decisions", decisionId),
          kind: "decision",
          active,
        };
        if (item.label != null) record.label = item.label;
        if (item.rationale != null) record.rationale = item.rationale;
        if (item.from != null) record.from = item.from;
        if (item.when != null) record.when = item.when;
        const selectedOption = active
          ? (selected[decisionId] ?? item.default)
          : null;
        if (selectedOption != null) record.selected = selectedOption;
        record.options = Object.fromEntries(
          Object.entries(options).map(([optionId, option]) => [
            optionId,
            asDict(option)?.label ?? optionId,
          ]),
        );
        if (insights) record.option_insights = insights;
        if (item.tags != null) record.tags = item.tags;
        records.push(record);
      }
    }

    const outputs = analysis.outputs;
    if (Array.isArray(outputs)) {
      for (const item of outputs) {
        const entry = asDict(item);
        if (!entry || typeof entry.id !== "string") continue;
        const outputId = entry.id;
        const canonical = recordPath(path, "outputs", outputId);
        const artifact = await discoverArtifact(
          access,
          directory,
          universeId,
          outputId,
          String(entry.type ?? ""),
        );
        const artifactRelative = artifact && !isExternalPath(artifact) ? artifact : undefined;
        const mediaType = artifactRelative ? mediaTypeFor(artifactRelative) : undefined;
        const resourceId = artifactRelative
          ? `resource:${scopeId || "root"}:output:${outputId}`
          : undefined;
        const record: LegacyRecord = {
          id: outputId,
          path: canonical,
          kind: "output",
        };
        if (entry.type != null) record.type = entry.type;
        if (entry.label != null) record.label = entry.label;
        if (entry.description != null) record.description = entry.description;
        if (entry.from != null) record.from = entry.from;
        if (entry.inputs != null) record.inputs = entry.inputs;
        if (entry.decisions != null) record.decisions = entry.decisions;
        if (entry.recipe != null) record.recipe = entry.recipe;
        if (entry.metric != null) record.metric = entry.metric;
        if (artifactRelative) {
          record.resolved_path = artifactRelative;
          record.mediaType = mediaType;
          record.available = true;
          record.resourceIds = [resourceId];
        }
        records.push(record);
        if (artifactRelative && resourceId) {
          const stat = await access.stat(artifactRelative);
          if (stat) {
            artifacts.push({
              id: resourceId,
              recordId: canonical,
              recordPath: canonical,
              path: artifactRelative,
              mediaType: mediaType!,
              size: stat.size,
              revision: (await sha256Hex([
                encoder.encode(`${artifactRelative}:${mtimeNsOf(stat)}:${stat.size}`),
              ])).slice(0, 16),
              availability: "available",
              source: "inferred",
            });
            dependencies.materialization.push(artifactRelative);
          }
        }
      }
    }

    for (const [collection, kind] of [
      ["findings", "finding"],
      ["prior_insights", "prior_insight"],
    ] as const) {
      const values = asDict(analysis[collection]);
      if (!values) continue;
      for (const [recordId, rawItem] of Object.entries(values)) {
        const item = asDict(rawItem);
        if (!item) continue;
        const evidence = extractEvidence(item.evidence);
        const record: LegacyRecord = {
          id: recordId,
          path: recordPath(path, collection, recordId),
          kind,
        };
        if (item.label != null) record.label = item.label;
        if (item.claim != null) record.claim = item.claim;
        if (item.notes != null) record.notes = item.notes;
        if (item.scope != null) record.scope = item.scope;
        record.evidence = evidence;
        if (kind === "prior_insight") {
          const doi = firstEvidenceValue(evidence, "doi");
          const quote = firstEvidenceValue(evidence, "quote");
          const page = firstEvidenceValue(evidence, "page");
          if (doi != null) record.doi = doi;
          if (quote != null) record.quote = quote;
          if (page != null) record.page = page;
        }
        records.push(record);
      }
    }

    scopes.push({
      id: scopeId,
      path: scopeId,
      name: String(
        path.length
          ? (analysis.name ?? analysis.id ?? path[path.length - 1])
          : (analysis.name ?? analysis.id ?? "ASTRA analysis"),
      ),
      parent,
      children: childIds,
      records,
    });

    for (const [childId, rawReference] of Object.entries(childRefs)) {
      const reference = asDict(rawReference);
      if (!reference) continue;
      let child = reference;
      let childDirectory = directory;
      const declaredPath = asString(reference.path);
      if (declaredPath) {
        let location = joinPath(directory, declaredPath);
        const stat = await access.stat(location);
        if (stat?.type === "directory") {
          location = joinPath(location, "astra.yaml");
        }
        child = await loadYamlDict(access, location);
        // A path reference may carry local display metadata; let it override
        // the loaded document without retaining the transport-only path field.
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
        scopeId,
      );
    }
  };

  await visit(rootAnalysis, "", [], universe, null);
  attachOutputProvenance(scopes);

  return {
    rootAnalysis,
    scopes,
    artifacts,
    diagnostics,
    universeId,
    availableUniverses: available,
    graphOrganization,
    dependencies,
  };
}

/**
 * Attach the flattened provenance consumed by ASTRA result viewers:
 * `inputs_root` (analysis-level inputs at the roots of the upstream output
 * chain) and `decisions_transitive` (every decision on that chain, with `via`
 * naming the owning scope when it is not the output's own).
 */
function attachOutputProvenance(scopes: LegacyScope[]): void {
  const scopesById = new Map(scopes.map((scope) => [scope.id, scope]));

  const recordsOfKind = (scope: LegacyScope, kind: string): LegacyRecord[] =>
    scope.records.filter((record) => record.kind === kind);

  const recordById = (
    scope: LegacyScope,
    kind: string,
    recordId: string,
  ): LegacyRecord | undefined =>
    recordsOfKind(scope, kind).find((record) => record.id === recordId);

  const parentScope = (scope: LegacyScope): LegacyScope | undefined =>
    scope.parent != null ? scopesById.get(scope.parent) : undefined;

  const childScope = (scope: LegacyScope, childId: string): LegacyScope | undefined => {
    const qualified = [scope.id, childId].filter(Boolean).join(".");
    const child = scopesById.get(qualified);
    return child && scope.children.includes(child.id) ? child : undefined;
  };

  const resolveOutputPath = (
    reference: string,
    scope: LegacyScope,
  ): [LegacyRecord, LegacyScope] | undefined => {
    const parts = reference.split(".");
    if (parts.length < 2 || parts.some((part) => !part)) return undefined;
    let base: LegacyScope | undefined = scope;
    while (base) {
      let owner: LegacyScope = base;
      let complete = true;
      for (const segment of parts.slice(0, -1)) {
        const child = childScope(owner, segment);
        if (!child) {
          complete = false;
          break;
        }
        owner = child;
      }
      if (complete) {
        const output = recordById(owner, "output", parts[parts.length - 1]!);
        if (output) return [output, owner];
      }
      base = parentScope(base);
    }
    return undefined;
  };

  const traceOutput = (
    output: LegacyRecord,
    pageScope: LegacyScope,
  ): [Dict[], Dict[]] => {
    const decisions = new Map<string, Dict>();
    const roots = new Map<string, Dict>();
    const seen = new Set<string>();
    const pageScopeId = pageScope.id || "";

    const addDecision = (decisionId: string, scope: LegacyScope): void => {
      let owner = scope;
      let decision = recordById(owner, "decision", decisionId);
      // Decision aliases may climb through more than one ancestor.
      while (decision) {
        let reference = decision.from;
        if (typeof reference !== "string" || !reference.startsWith("../")) break;
        while (typeof reference === "string" && reference.startsWith("../")) {
          const parent = parentScope(owner);
          if (!parent) break;
          owner = parent;
          reference = reference.slice(3);
        }
        decisionId = reference as string;
        decision = recordById(owner, "decision", decisionId);
      }

      const ownerId = owner.id || "";
      const via = ownerId === pageScopeId ? undefined : (ownerId || "root");
      const selectedValue = decision?.selected;
      const options = asDict(decision?.options);
      const selection = options && typeof selectedValue === "string"
        ? options[selectedValue]
        : selectedValue;
      const dependency: Dict = { id: decisionId };
      if (decision?.label != null) dependency.label = decision.label;
      if (selection != null) dependency.selection = selection;
      if (via != null) dependency.via = via;

      const previous = decisions.get(decisionId);
      // A dependency owned by the page scope is the most specific form.
      // Otherwise retain the first traversal hit for stable ordering.
      if (previous && (!("via" in previous) || "via" in dependency)) return;
      decisions.set(decisionId, dependency);
    };

    const addRoot = (inputRecord: LegacyRecord | string, scope: LegacyScope): void => {
      let inputId: string;
      let label: unknown;
      let reference: unknown;
      if (typeof inputRecord === "string") {
        inputId = inputRecord;
        label = undefined;
        reference = undefined;
      } else {
        if (typeof inputRecord.id !== "string") return;
        inputId = inputRecord.id;
        label = inputRecord.label;
        reference = inputRecord.from;
      }

      let owner = scope;
      while (
        typeof reference === "string"
        && !reference.includes(".")
        && parentScope(owner)
      ) {
        owner = parentScope(owner)!;
        const source = recordById(owner, "input", reference);
        if (!source) break;
        inputId = source.id;
        label = label ?? source.label;
        reference = source.from;
      }

      if (!roots.has(inputId)) {
        const root: Dict = { id: inputId };
        if (label != null) root.label = label;
        roots.set(inputId, root);
      }
    };

    const trace = (current: LegacyRecord, scope: LegacyScope): void => {
      const key = `${scope.id || ""}::${current.id}`;
      if (seen.has(key)) return;
      seen.add(key);

      const alias = current.from;
      if (typeof alias === "string") {
        const resolved = resolveOutputPath(alias, scope);
        if (!resolved) return;
        trace(...resolved);
        return;
      }

      const directDecisions = current.decisions;
      if (Array.isArray(directDecisions)) {
        for (const decisionId of directDecisions) {
          if (typeof decisionId === "string") addDecision(decisionId, scope);
        }
      }

      const inputs = current.inputs;
      if (!Array.isArray(inputs)) return;
      for (const reference of inputs) {
        if (typeof reference !== "string") continue;
        if (reference.includes(".")) {
          const resolved = resolveOutputPath(reference, scope);
          if (resolved) trace(...resolved);
          else addRoot(reference, scope);
          continue;
        }

        const inputRecord = recordById(scope, "input", reference);
        if (inputRecord) {
          const source = inputRecord.from;
          if (typeof source === "string" && source.includes(".")) {
            const resolved = resolveOutputPath(source, scope);
            if (resolved) trace(...resolved);
            else addRoot(inputRecord, scope);
          } else {
            addRoot(inputRecord, scope);
          }
          continue;
        }

        const sameScopeOutput = recordById(scope, "output", reference);
        if (sameScopeOutput) trace(sameScopeOutput, scope);
        else addRoot(reference, scope);
      }
    };

    trace(output, pageScope);
    return [[...roots.values()], [...decisions.values()]];
  };

  for (const scope of scopes) {
    for (const output of recordsOfKind(scope, "output")) {
      const [inputsRoot, decisionsTransitive] = traceOutput(output, scope);
      output.inputs_root = inputsRoot;
      output.decisions_transitive = decisionsTransitive;
    }
  }
}

// ---------------------------------------------------------------------------
// Canonical projection (the adapter formerly known as legacy.ts).
// ---------------------------------------------------------------------------

const KINDS_INPUT_OUTPUT = ["input", "output"] as const;
const KINDS_DECISION = ["decision"] as const;
const KINDS_OUTPUT = ["output"] as const;
const KINDS_INSIGHT = ["prior_insight"] as const;

function viewOutputType(value: unknown): string {
  return typeof value === "string" && OUTPUT_TYPES.has(value) ? value : "other";
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

function normalizedScopeId(scopeId: string): string {
  return scopeId || "root";
}

function localRecordId(path: string): string {
  const parts = path.split(".");
  return parts[parts.length - 1] ?? path;
}

function parentScopePath(path: string): string {
  const segments = path.split(".").filter(Boolean);
  segments.pop();
  return segments.join(".");
}

function legacyEvidence(record: LegacyRecord): Dict[] {
  const evidence = record.evidence;
  if (Array.isArray(evidence) && evidence.length) {
    return evidence.map((item) => {
      const source = item as Dict;
      const entry: Dict = {};
      if (source.artifact) entry.artifactRecordId = source.artifact;
      if (source.doi) entry.doi = source.doi;
      if (source.quote) entry.quote = source.quote;
      if ("page" in source) entry.page = source.page;
      return entry;
    });
  }
  if (!record.doi && !record.quote && !("page" in record)) return [];
  const entry: Dict = {};
  if (record.doi) entry.doi = record.doi;
  if (record.quote) entry.quote = record.quote;
  if ("page" in record) entry.page = record.page;
  return [entry];
}

function projectCanonicalModel(
  structures: LoadedStructures,
  revisions: ProjectRevisions,
): ProjectViewModelV1 {
  const { scopes, rootAnalysis, universeId, availableUniverses } = structures;
  const analysisRevision = revisions.analysis;
  const selectionRevision = revisions.selection;

  const resources: Dict[] = [];
  const resourceIdSet = new Set<string>();
  const records: Dict[] = [];
  const selectedDecisions: Record<string, string> = {};
  const adapterDiagnostics: Dict[] = [];

  const scopeIdMap = new Map(scopes.map((scope) => [scope.id, normalizedScopeId(scope.id)]));
  const legacyByModelId = new Map<string, LegacyRecord>();
  const modelIdByPath = new Map<string, string>();
  const candidatesByScopeAndLocalId = new Map<string, string[]>();

  for (const scope of scopes) {
    const scopeId = normalizedScopeId(scope.id);
    for (const record of scope.records) {
      const modelId = `${scopeId}:${record.kind}:${record.id}`;
      legacyByModelId.set(modelId, record);
      modelIdByPath.set(record.path, modelId);
      const key = `${scopeId}\0${localRecordId(record.path)}`;
      const candidates = candidatesByScopeAndLocalId.get(key) ?? [];
      candidates.push(modelId);
      candidatesByScopeAndLocalId.set(key, candidates);
    }
  }

  const resolveReference = (
    sourceScope: LegacyScope,
    rawReference: string,
    targetKinds: readonly string[],
  ): string | undefined => {
    const exact = modelIdByPath.get(rawReference);
    if (exact && targetKinds.includes(legacyByModelId.get(exact)!.kind)) {
      return exact;
    }

    let reference = rawReference;
    let targetScopePath = sourceScope.path;
    while (reference.startsWith("../")) {
      reference = reference.slice(3);
      targetScopePath = parentScopePath(targetScopePath);
    }

    const candidatePaths: string[] = [];
    let candidatePath = targetScopePath;
    for (;;) {
      candidatePaths.push(candidatePath);
      if (!candidatePath) break;
      candidatePath = parentScopePath(candidatePath);
    }
    let scopeCandidates = candidatePaths.flatMap((path) =>
      scopes.filter((scope) =>
        path
          ? scope.path === path || scope.id === path
          : scope.path === "" || scope.id === "",
      ),
    );

    const qualifiedSegments = reference.split(".").filter(Boolean);
    if (qualifiedSegments.length > 1) {
      const recordId = qualifiedSegments[qualifiedSegments.length - 1]!;
      const scopePath = qualifiedSegments.slice(0, -1).join(".");
      const qualifiedScopes = scopes.filter(
        (scope) => scope.path === scopePath || scope.id === scopePath,
      );
      if (qualifiedScopes.length) scopeCandidates = qualifiedScopes;
      reference = recordId;
    }

    for (const scope of scopeCandidates) {
      const key = `${normalizedScopeId(scope.id)}\0${reference}`;
      const matches = (candidatesByScopeAndLocalId.get(key) ?? []).filter((modelId) =>
        targetKinds.includes(legacyByModelId.get(modelId)!.kind),
      );
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return undefined;
    }
    return undefined;
  };

  const resolvedRelation = (
    sourceScope: LegacyScope,
    sourceRecord: LegacyRecord,
    kind: string,
    rawReference: string,
    targetKinds: readonly string[],
    direct = true,
  ): Dict | undefined => {
    const targetRecordId = resolveReference(sourceScope, rawReference, targetKinds);
    if (targetRecordId) return { kind, targetRecordId, direct };
    adapterDiagnostics.push({
      severity: "warning",
      code: "legacy_unresolved_relation",
      message:
        `Could not uniquely resolve ${kind} reference `
        + `"${rawReference}" from ${sourceRecord.path}.`,
      canonicalPath: sourceRecord.path,
    });
    return undefined;
  };

  const findRootScope = (): LegacyScope | undefined =>
    scopes.find((candidate) => !candidate.id && !candidate.path);
  const findScopeByReference = (via: string): LegacyScope | undefined =>
    scopes.find((candidate) => candidate.id === via || candidate.path === via);

  for (const scope of scopes) {
    const scopeId = normalizedScopeId(scope.id);
    for (const record of scope.records) {
      const recordId = `${scopeId}:${record.kind}:${record.id}`;
      let recordResourceIds: string[] = [];
      if (record.kind === "output") {
        const declared = record.resourceIds;
        if (Array.isArray(declared) && declared.length) {
          recordResourceIds = [...declared] as string[];
        } else if (record.resolved_path) {
          recordResourceIds = [`resource:${recordId}`];
        }
      }
      if (
        record.kind === "output"
        && record.resolved_path
        && recordResourceIds.length
        && !resourceIdSet.has(recordResourceIds[0]!)
      ) {
        const resourceId = recordResourceIds[0]!;
        const fileName = basename(String(record.resolved_path));
        const resource: Dict = {
          id: resourceId,
          kind: resourceKind(record.type),
        };
        if (fileName) resource.fileName = fileName;
        if (record.mediaType) resource.mediaType = record.mediaType;
        if ("byteSize" in record) resource.byteSize = record.byteSize;
        if (record.resourceRevision) resource.revision = record.resourceRevision;
        resource.availability = "available";
        resource.source = "inferred";
        resource.outputRecordId = recordId;
        resources.push(resource);
        resourceIdSet.add(resourceId);
      }

      const directRelations: (Dict | undefined)[] = [];
      for (const reference of (record.inputs as unknown[] | undefined) ?? []) {
        directRelations.push(
          resolvedRelation(scope, record, "depends_on", String(reference), KINDS_INPUT_OUTPUT),
        );
      }
      for (const item of (record.inputs_root as unknown[] | undefined) ?? []) {
        directRelations.push(
          resolvedRelation(
            scope,
            record,
            "depends_on",
            typeof item === "string" ? item : String((item as Dict).id),
            KINDS_INPUT_OUTPUT,
            false,
          ),
        );
      }
      for (const reference of (record.decisions as unknown[] | undefined) ?? []) {
        directRelations.push(
          resolvedRelation(scope, record, "parameterized_by", String(reference), KINDS_DECISION),
        );
      }
      if (record.from) {
        directRelations.push(
          resolvedRelation(
            scope,
            record,
            "aliases",
            String(record.from),
            record.kind === "input" ? KINDS_INPUT_OUTPUT : [record.kind],
          ),
        );
      }
      for (const item of (record.evidence as Dict[] | undefined) ?? []) {
        if (item.artifact) {
          directRelations.push(
            resolvedRelation(scope, record, "evidenced_by", String(item.artifact), KINDS_OUTPUT),
          );
        }
      }

      const transitiveDecisionRelations: (Dict | undefined)[] = [];
      if (record.kind === "output") {
        for (const dependency of (record.decisions_transitive as Dict[] | undefined) ?? []) {
          const via = dependency.via as string | undefined;
          const owner = via === "root"
            ? findRootScope()
            : via
              ? findScopeByReference(via)
              : scope;
          if (!owner) {
            adapterDiagnostics.push({
              severity: "warning",
              code: "legacy_unresolved_relation_scope",
              message: `Could not resolve decision scope "${via}" from ${record.path}.`,
              canonicalPath: record.path,
            });
            continue;
          }
          transitiveDecisionRelations.push(
            resolvedRelation(
              owner,
              record,
              "parameterized_by",
              String(dependency.id),
              KINDS_DECISION,
              false,
            ),
          );
        }
      }

      const relationByTarget = new Map<string, Dict>();
      for (const item of [...directRelations, ...transitiveDecisionRelations]) {
        if (!item) continue;
        const key = `${item.kind}\0${item.targetRecordId}`;
        const previous = relationByTarget.get(key);
        if (!previous || (previous.direct === false && item.direct !== false)) {
          relationByTarget.set(key, item);
        }
      }
      const relations = [...relationByTarget.values()];

      let outputProvenance: Dict | undefined;
      if (record.kind === "output") {
        const directInputRecordIds = new Set<string>();
        const inputs: Dict[] = [];
        for (const reference of (record.inputs as unknown[] | undefined) ?? []) {
          const resolved = resolveReference(scope, String(reference), KINDS_INPUT_OUTPUT);
          if (resolved) directInputRecordIds.add(resolved);
          const entry: Dict = { reference };
          if (resolved) entry.recordId = resolved;
          entry.direct = true;
          inputs.push(entry);
        }
        for (const item of (record.inputs_root as unknown[] | undefined) ?? []) {
          const reference = typeof item === "string" ? item : String((item as Dict).id);
          const resolved = resolveReference(scope, reference, KINDS_INPUT_OUTPUT);
          if (resolved && directInputRecordIds.has(resolved)) continue;
          const entry: Dict = { reference };
          if (resolved) entry.recordId = resolved;
          if (typeof item !== "string" && (item as Dict).label) {
            entry.label = (item as Dict).label;
          }
          entry.direct = false;
          inputs.push(entry);
        }

        const directDecisionRecordIds = new Set<string>();
        const decisionsProvenance: Dict[] = [];
        const declaredDecisions = (record.decisions as unknown[] | undefined) ?? [];
        const transitive = (record.decisions_transitive as Dict[] | undefined) ?? [];
        for (const reference of declaredDecisions) {
          const resolved = resolveReference(scope, String(reference), KINDS_DECISION);
          if (resolved) directDecisionRecordIds.add(resolved);
          const metadata = transitive.find((candidate) => candidate.id === reference);
          const entry: Dict = { reference };
          if (resolved) entry.recordId = resolved;
          if (metadata?.label) entry.label = metadata.label;
          if (metadata?.via) entry.scopeId = metadata.via;
          if (metadata?.selection) entry.selection = metadata.selection;
          entry.direct = true;
          decisionsProvenance.push(entry);
        }
        for (const dependency of transitive) {
          const via = dependency.via as string | undefined;
          const owner = via === "root"
            ? findRootScope()
            : via
              ? findScopeByReference(via)
              : scope;
          const resolved = owner
            ? resolveReference(owner, String(dependency.id), KINDS_DECISION)
            : undefined;
          if (
            (resolved && directDecisionRecordIds.has(resolved))
            || declaredDecisions.includes(dependency.id)
          ) {
            continue;
          }
          const entry: Dict = { reference: dependency.id };
          if (resolved) entry.recordId = resolved;
          if (dependency.label) entry.label = dependency.label;
          if (dependency.via) entry.scopeId = dependency.via;
          if (dependency.selection) entry.selection = dependency.selection;
          entry.direct = false;
          decisionsProvenance.push(entry);
        }
        outputProvenance = { inputs, decisions: decisionsProvenance };
      }

      const insightRecordIds = new Map<string, string[]>();
      for (const [optionId, insightReferences] of Object.entries(
        (record.option_insights as Record<string, string[]> | undefined) ?? {},
      )) {
        const resolvedInsights = insightReferences
          .map((reference) => resolveReference(scope, reference, KINDS_INSIGHT))
          .filter((value): value is string => Boolean(value));
        if (resolvedInsights.length) insightRecordIds.set(optionId, resolvedInsights);
        for (const reference of insightReferences) {
          if (!resolveReference(scope, reference, KINDS_INSIGHT)) {
            adapterDiagnostics.push({
              severity: "warning",
              code: "legacy_unresolved_option_insight",
              message:
                `Could not uniquely resolve option insight `
                + `"${reference}" from ${record.path}.`,
              canonicalPath: record.path,
            });
          }
        }
      }

      const base: Dict = {
        id: recordId,
        localId: record.id,
        canonicalPath: record.path,
        scopeId,
        kind: record.kind,
      };
      if (record.label) base.label = record.label;
      if (record.description) base.description = record.description;
      if ("active" in record) base.active = record.active;
      if (record.tags != null) base.tags = record.tags;
      base.relations = relations;

      if (record.kind === "input") {
        if (record.type) base.inputType = record.type;
        if (record.source) base.source = record.source;
        if (record.ref) base.reference = record.ref;
      } else if (record.kind === "decision") {
        const options: Dict[] = [];
        for (const [optionId, label] of Object.entries(
          (record.options as Record<string, unknown> | undefined) ?? {},
        )) {
          const option: Dict = { id: optionId };
          if (label) option.label = label;
          option.selected = optionId === record.selected;
          const insights = insightRecordIds.get(optionId);
          if (insights?.length) option.insightRecordIds = [...insights];
          options.push(option);
        }
        if (record.rationale) base.rationale = record.rationale;
        if (record.selected) base.selectedOptionId = record.selected;
        base.options = options;
      } else if (record.kind === "output") {
        base.outputType = viewOutputType(record.type);
        if (record.recipe) base.recipe = record.recipe;
        base.resourceIds = recordResourceIds;
        base.provenance = outputProvenance ?? { inputs: [], decisions: [] };
        const metric = asDict(record.metric);
        if (metric) {
          const adaptedMetric: Dict = {};
          if ("value" in metric) adaptedMetric.value = metric.value;
          const uncertainty = metric.uncertainty ?? metric.error;
          if (uncertainty != null) adaptedMetric.uncertainty = uncertainty;
          const unit = metric.unit ?? metric.units;
          if (unit) adaptedMetric.unit = unit;
          if (metric.label) adaptedMetric.label = metric.label;
          base.metric = adaptedMetric;
        }
      } else {
        if (record.claim) base.claim = record.claim;
        if (record.notes) base.notes = record.notes;
        base.evidence = legacyEvidence(record);
      }

      records.push(base);
      if (record.kind === "decision" && record.selected) {
        selectedDecisions[recordId] = String(record.selected);
      }
    }
  }

  // Enrich synthesized resources with the artifact metadata the host serves.
  const artifactsById = new Map(structures.artifacts.map((artifact) => [artifact.id, artifact]));
  const enrichedResources = resources.map((resource) => {
    const artifact = artifactsById.get(resource.id as string);
    if (!artifact) return resource;
    const fileName = basename(artifact.path);
    const merged: Dict = { ...resource };
    merged.mediaType = artifact.mediaType;
    if (fileName) merged.fileName = fileName;
    merged.byteSize = artifact.size;
    if (artifact.revision) merged.revision = artifact.revision;
    merged.availability = "available";
    merged.source = "inferred";
    return merged;
  });

  const modelScopes = scopes.map((scope) => {
    const adapted: Dict = {
      id: normalizedScopeId(scope.id),
      canonicalPath: scope.path || "root",
      name: scope.name,
    };
    if (scope.parent != null) {
      adapted.parentId = scopeIdMap.get(scope.parent) ?? normalizedScopeId(scope.parent);
    }
    adapted.childIds = scope.children.map(
      (childId) => scopeIdMap.get(childId) ?? normalizedScopeId(childId),
    );
    adapted.recordIds = scope.records.map(
      (record) => `${normalizedScopeId(scope.id)}:${record.kind}:${record.id}`,
    );
    return adapted;
  });

  const identity: Dict = {
    id: rootAnalysis.id ?? "root",
    name: rootAnalysis.name ?? rootAnalysis.id ?? "ASTRA analysis",
  };
  if (typeof rootAnalysis.description === "string") {
    identity.description = rootAnalysis.description;
  }
  if (typeof rootAnalysis.version === "string") {
    identity.astraVersion = rootAnalysis.version;
  }

  const diagnostics: Dict[] = [];
  for (const diagnostic of structures.diagnostics) {
    const entry: Dict = {
      severity: diagnostic.severity,
      code: diagnostic.code ?? "legacy_inventory_diagnostic",
      message: diagnostic.message,
    };
    if (diagnostic.path) entry.canonicalPath = diagnostic.path;
    diagnostics.push(entry);
  }
  diagnostics.push(...adapterDiagnostics);

  const revisionEntry: Dict = { analysis: analysisRevision };
  if (selectionRevision) revisionEntry.selection = selectionRevision;

  return {
    schemaVersion: PROJECT_VIEW_MODEL_SCHEMA_VERSION,
    revision: revisionEntry,
    project: identity,
    selection: {
      ...(structures.universeId ? { universeId: structures.universeId } : {}),
      availableUniverses: availableUniverses,
      decisions: selectedDecisions,
      source: structures.universeId ? "explicit" : "unknown",
    },
    scopes: modelScopes,
    records,
    resources: enrichedResources,
    diagnostics,
  } as unknown as ProjectViewModelV1;
}

function collectCitedDois(scopes: LegacyScope[]): string[] {
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
  for (const scope of scopes) {
    for (const record of scope.records) {
      if (record.kind !== "prior_insight") continue;
      const candidates = [
        record.doi,
        ...((record.evidence as Dict[] | undefined) ?? []).map((item) => item.doi),
      ];
      for (const doi of candidates) {
        if (typeof doi === "string") dois.add(normalize(doi));
      }
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
  const structures = await loadStructures(access, options);
  const revisions: ProjectRevisions = {
    analysis: await dependencyDigest(access, structures.dependencies.analysis),
    selection: await dependencyDigest(access, structures.dependencies.selection),
    materialization: await dependencyDigest(access, structures.dependencies.materialization),
    organization: await dependencyDigest(access, structures.dependencies.organization),
  };
  const revision = (await sha256Hex([
    encoder.encode(
      `${revisions.analysis}:${revisions.selection}:`
      + `${revisions.materialization}:${revisions.organization}`,
    ),
  ])).slice(0, 16);

  const model = projectCanonicalModel(structures, revisions);

  const bundle: ProjectViewBundle = {
    model,
    artifacts: structures.artifacts,
    revisions,
    revision,
    dependencies: structures.dependencies,
    citedDois: collectCitedDois(structures.scopes),
  };
  if (structures.graphOrganization.value !== undefined) {
    bundle.graphOrganization = structures.graphOrganization.value;
  }
  return bundle;
}
