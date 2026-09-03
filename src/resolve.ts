import { parse as parseYaml } from "yaml";

import { injectAnalysisNodeIds } from "./authored-ids.js";
import {
  isValidProjectEntry,
  joinProjectPath,
  ProjectPathError,
  projectDirname,
  type ProjectDirectoryEntry,
  type ProjectEntry,
  type ProjectReader,
} from "./project-reader.js";
import {
  RESOLVED_ANALYSIS_SCHEMA_VERSION,
  type ArtifactBinding,
  type ResolvedAnalysisBundle,
  type ResolvedAnalysisNode,
  type ResolvedDecision,
  type ResolvedEvidence,
  type ResolvedInput,
  type ResolvedInsight,
  type ResolvedOption,
  type ResolvedOutput,
  type ResolvedRootAnalysis,
  type OutputProvenance,
} from "./resolved-types.js";
import type {
  Analysis,
  Decision,
  Input,
  Insight,
  Option,
  Output,
  Universe,
  UniverseNode,
} from "./types.js";
import {
  validateAnalysisStructure,
  validateUniverseStructure,
} from "./validation/schema.js";

export interface ResolveAnalysisOptions {
  /** Select this root universe instead of the first filename. */
  universeId?: string;
}

export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  /** Project-relative YAML file containing the invalid value. */
  readonly file: string;
  /** Path within the authored YAML document. */
  readonly path?: string;
}

export interface AnalysisValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

export class AnalysisValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(`Invalid ASTRA project (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
    this.name = "AnalysisValidationError";
    this.issues = issues;
  }
}

export type ProjectLoadErrorCode =
  | "PROJECT_NOT_FOUND"
  | "READ_FAILED"
  | "UNIVERSE_NOT_FOUND"
  | "PROJECT_PATH_ESCAPE";

export class ProjectLoadError extends Error {
  readonly code: ProjectLoadErrorCode;
  readonly path?: string;

  constructor(code: ProjectLoadErrorCode, message: string, path?: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ProjectLoadError";
    this.code = code;
    this.path = path;
  }
}

type Dict = Record<string, unknown>;

interface LoadedUniverse {
  data: Universe;
  file: string;
  id: string;
  valid: boolean;
}

interface LoadedAnalysis {
  data: Analysis;
  file: string;
  directory: string;
  canonicalSegments: string[];
  /** Analysis segments relative to this context's physical astra.yaml. */
  authoredSegments: string[];
  artifactPrefix: string[];
  parent?: LoadedAnalysis;
  id?: string;
  pathBacked: boolean;
  physicalRoot: LoadedAnalysis;
  children: LoadedAnalysis[];
  childById: Map<string, LoadedAnalysis>;
  universes: LoadedUniverse[];
  universeById: Map<string, LoadedUniverse>;
  valid: boolean;
}

interface SelectionState {
  data: Universe | UniverseNode;
  file: string;
  pathPrefix: string;
  mode: "universe" | "defaults";
  effectiveUniverseId: string;
}

interface SelectionPlan {
  states: Map<LoadedAnalysis, SelectionState>;
}

interface AliasTarget<T> {
  context: LoadedAnalysis;
  value: T;
  canonicalPath: string;
}

interface AliasResolution<T> extends AliasTarget<T> {
  /** Direct target, retained so alias activity can be evaluated link by link. */
  immediate: AliasTarget<T>;
}

interface ConditionLink {
  decision: Decision;
  optionId: string;
  negated: boolean;
}

interface ConstraintLink {
  reference: string;
  decision: Decision;
  optionId: string;
}

interface OptionLinks {
  incompatible: ConstraintLink[];
  required: ConstraintLink[];
}

interface ProjectLinks {
  inputAliases: Map<Input, AliasTarget<Input | Output>>;
  outputAliases: Map<Output, AliasResolution<Output>>;
  decisionAliases: Map<Decision, AliasResolution<Decision>>;
  conditions: Map<Decision | Output, ConditionLink[]>;
  optionConstraints: Map<Decision, Map<string, OptionLinks>>;
  optionInsightPaths: Map<Decision, Map<string, string[]>>;
  insightEvidencePaths: Map<Insight, Array<string | undefined>>;
  outputProvenance: Map<Output, OutputProvenance>;
}

function createProjectLinks(): ProjectLinks {
  return {
    inputAliases: new Map(),
    outputAliases: new Map(),
    decisionAliases: new Map(),
    conditions: new Map(),
    optionConstraints: new Map(),
    optionInsightPaths: new Map(),
    insightEvidencePaths: new Map(),
    outputProvenance: new Map(),
  };
}

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;

function asDict(value: unknown): Dict | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Dict
    : undefined;
}

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function hasObjectCycle(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value !== "object") return false;
  if (ancestors.has(value)) return true;
  ancestors.add(value);
  for (const child of Object.values(value)) {
    if (hasObjectCycle(child, ancestors)) return true;
  }
  ancestors.delete(value);
  return false;
}

function hasNonJsonValue(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasNonJsonValue);
  if (value === null || typeof value !== "object") return false;
  const mapping = asDict(value);
  return !mapping || Object.values(mapping).some(hasNonJsonValue);
}

/** LinkML serializations use null object fields to mean "not supplied". */
function omitNullObjectFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) omitNullObjectFields(item);
    return;
  }
  const mapping = asDict(value);
  if (!mapping) return;
  for (const [key, child] of Object.entries(mapping)) {
    if (child === null) delete mapping[key];
    else omitNullObjectFields(child);
  }
}

function analysisPath(context: LoadedAnalysis): string {
  return context.canonicalSegments.length
    ? context.canonicalSegments.join(".")
    : "$";
}

function recordPath(
  context: LoadedAnalysis,
  collection: string,
  id: string,
): string {
  const prefix = context.canonicalSegments.join(".");
  return prefix ? `${prefix}.${collection}.${id}` : `${collection}.${id}`;
}

function authoredPath(
  context: LoadedAnalysis,
  collection?: string,
  id?: string,
): string | undefined {
  const prefix = context.authoredSegments
    .flatMap((segment) => ["analyses", segment])
    .join(".");
  return [prefix, collection, id].filter(Boolean).join(".") || undefined;
}

function causeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathError(path: string, error: unknown): ProjectLoadError {
  return new ProjectLoadError(
    "PROJECT_PATH_ESCAPE",
    `Project path escapes the project root: ${path}. ${causeMessage(error)}`,
    path,
    error,
  );
}

function readerError(
  action: string,
  path: string,
  error: unknown,
): ProjectLoadError {
  if (error instanceof ProjectPathError) return pathError(path, error);
  return new ProjectLoadError(
    "READ_FAILED",
    `Could not ${action} ${path || "the project root"}: ${causeMessage(error)}`,
    path,
    error,
  );
}

function normalizedJoin(...paths: string[]): string {
  try {
    return joinProjectPath(...paths);
  } catch (error) {
    throw pathError(paths.join("/"), error);
  }
}

async function readStat(
  reader: ProjectReader,
  path: string,
): Promise<ProjectEntry | undefined> {
  let entry: unknown;
  try {
    entry = await reader.stat(path);
  } catch (error) {
    throw readerError("stat", path, error);
  }
  if (entry === undefined) return undefined;
  if (entry === null || typeof entry !== "object"
    || !isValidProjectEntry(entry as ProjectEntry)) {
    throw new ProjectLoadError(
      "READ_FAILED",
      `Reader returned malformed metadata for ${path || "the project root"}`,
      path,
    );
  }
  return entry as ProjectEntry;
}

async function readDirectory(
  reader: ProjectReader,
  path: string,
): Promise<ProjectDirectoryEntry[]> {
  let response: unknown;
  try {
    response = await reader.readDirectory(path);
  } catch (error) {
    throw readerError("read directory", path, error);
  }
  if (!Array.isArray(response)) {
    throw new ProjectLoadError(
      "READ_FAILED",
      `Reader returned a malformed directory listing for ${path || "the project root"}`,
      path,
    );
  }
  const entries = response as ProjectDirectoryEntry[];
  for (const entry of entries) {
    if (!entry
      || typeof entry.name !== "string"
      || !entry.name
      || entry.name === "."
      || entry.name === ".."
      || entry.name.includes("/")
      || entry.name.includes("\\")
      || (entry.type !== "file" && entry.type !== "directory")) {
      throw new ProjectLoadError(
        "READ_FAILED",
        `Reader returned a malformed directory entry for ${path || "the project root"}`,
        path,
      );
    }
  }
  return entries;
}

async function readMapping(
  reader: ProjectReader,
  path: string,
  issues: ValidationIssue[],
): Promise<{ data: Dict; valid: boolean }> {
  let text: unknown;
  try {
    text = await reader.readText(path);
  } catch (error) {
    throw readerError("read", path, error);
  }
  if (typeof text !== "string") {
    throw new ProjectLoadError(
      "READ_FAILED",
      `Reader returned non-text content for ${path}`,
      path,
    );
  }
  try {
    const parsed: unknown = parseYaml(text);
    const mapping = asDict(parsed);
    if (!mapping) throw new Error("YAML root must be a mapping/object");
    if (hasObjectCycle(mapping)) throw new Error("YAML must not contain recursive aliases");
    if (hasNonJsonValue(mapping)) {
      throw new Error("YAML must contain only JSON-compatible values");
    }
    omitNullObjectFields(mapping);
    return { data: mapping, valid: true };
  } catch (error) {
    pushIssue(issues, {
      code: "INVALID_YAML",
      message: `Could not parse ${path}: ${causeMessage(error)}`,
      file: path,
    });
    return { data: {}, valid: false };
  }
}

function pushIssue(
  issues: ValidationIssue[],
  issue: ValidationIssue,
): void {
  if (!issues.some((candidate) =>
    candidate.code === issue.code
    && candidate.message === issue.message
    && candidate.file === issue.file
    && candidate.path === issue.path)) {
    issues.push(issue);
  }
}

async function loadUniverses(
  reader: ProjectReader,
  context: LoadedAnalysis,
  issues: ValidationIssue[],
): Promise<void> {
  const directory = normalizedJoin(context.directory, "universes");
  const stat = await readStat(reader, directory);
  if (!stat) return;
  if (stat.type !== "directory") {
    pushIssue(issues, {
      code: "INVALID_UNIVERSES_DIRECTORY",
      message: `Expected ${directory} to be a directory`,
      file: context.file,
      path: "universes",
    });
    return;
  }
  const filenames = (await readDirectory(reader, directory))
    .filter((entry) => entry.type === "file" && /\.ya?ml$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const seenStems = new Set<string>();
  for (const filename of filenames) {
    const stem = filename.replace(/\.ya?ml$/, "");
    const file = normalizedJoin(directory, filename);
    if (seenStems.has(stem)) {
      pushIssue(issues, {
        code: "DUPLICATE_UNIVERSE_ID",
        message: `Both .yaml and .yml files declare universe '${stem}'`,
        file,
        path: "id",
      });
    }
    seenStems.add(stem);
    const parsed = await readMapping(reader, file, issues);
    const data = parsed.data;
    const id = typeof data.id === "string" ? data.id : stem;
    if (parsed.valid && data.id !== stem) {
      pushIssue(issues, {
        code: "UNIVERSE_FILENAME_MISMATCH",
        message: `Universe id must match filename '${stem}'`,
        file,
        path: "id",
      });
    }
    const loaded = {
      data: data as unknown as Universe,
      file,
      id,
      valid: parsed.valid,
    };
    context.universes.push(loaded);
    if (!context.universeById.has(id)) context.universeById.set(id, loaded);
  }
}

async function loadAnalysisFile(
  reader: ProjectReader,
  file: string,
  issues: ValidationIssue[],
  options: {
    canonicalSegments: string[];
    authoredSegments: string[];
    artifactPrefix: string[];
    pathBacked: boolean;
    parent?: LoadedAnalysis;
    id?: string;
    ancestry: Set<string>;
  },
): Promise<LoadedAnalysis> {
  const stat = await readStat(reader, file);
  let exists = true;
  if (!stat || stat.type !== "file") {
    if (!options.parent) {
      throw new ProjectLoadError(
        "PROJECT_NOT_FOUND",
        "No astra.yaml file was found in the project root",
        file,
      );
    }
    pushIssue(issues, {
      code: "ANALYSIS_FILE_NOT_FOUND",
      message: `Declared analysis file does not exist: ${file}`,
      file: options.parent.file,
      path: authoredPath(options.parent, "analyses", options.id),
    });
    exists = false;
  }
  const parsed = exists
    ? await readMapping(reader, file, issues)
    : { data: {}, valid: false };
  const data = parsed.data;
  injectAnalysisNodeIds(data);
  const context = {
    data: data as Analysis,
    file,
    directory: projectDirname(file),
    canonicalSegments: options.canonicalSegments,
    authoredSegments: options.authoredSegments,
    artifactPrefix: options.artifactPrefix,
    parent: options.parent,
    id: options.id,
    pathBacked: options.pathBacked,
    physicalRoot: undefined as unknown as LoadedAnalysis,
    children: [],
    childById: new Map<string, LoadedAnalysis>(),
    universes: [],
    universeById: new Map<string, LoadedUniverse>(),
    valid: parsed.valid,
  } satisfies LoadedAnalysis;
  context.physicalRoot = context;
  if (exists) {
    await loadUniverses(reader, context, issues);
    await loadChildren(reader, context, issues, new Set([...options.ancestry, file]));
  }
  return context;
}

async function loadChildren(
  reader: ProjectReader,
  context: LoadedAnalysis,
  issues: ValidationIssue[],
  ancestry: Set<string>,
): Promise<void> {
  const analyses = asDict((context.data as Dict).analyses);
  if (!analyses) return;
  for (const [id, rawChild] of Object.entries(analyses)) {
    const childData = asDict(rawChild);
    if (!childData) continue;
    const childSegments = [...context.canonicalSegments, id];
    let child: LoadedAnalysis;
    if (typeof childData.path === "string" && childData.path) {
      let directory: string;
      let file: string;
      try {
        directory = normalizedJoin(context.directory, childData.path);
        file = normalizedJoin(directory, "astra.yaml");
      } catch (error) {
        pushIssue(issues, {
          code: "ANALYSIS_PATH_ESCAPE",
          message: `Analysis.path escapes the project root: ${childData.path}. ${causeMessage(error)}`,
          file: context.file,
          path: `${authoredPath(context, "analyses", id)}.path`,
        });
        continue;
      }
      if (ancestry.has(file)) {
        pushIssue(issues, {
          code: "ANALYSIS_PATH_CYCLE",
          message: `Analysis.path creates a loading cycle through ${file}`,
          file: context.file,
          path: `${authoredPath(context, "analyses", id)}.path`,
        });
        continue;
      }
      child = await loadAnalysisFile(reader, file, issues, {
        canonicalSegments: childSegments,
        authoredSegments: [],
        artifactPrefix: [],
        pathBacked: true,
        parent: context,
        id,
        ancestry,
      });
    } else {
      const cloned = structuredClone(childData) as Analysis;
      if (cloned.id == null) cloned.id = id;
      injectAnalysisNodeIds(cloned as Dict);
      child = {
        data: cloned,
        file: context.file,
        directory: context.directory,
        canonicalSegments: childSegments,
        authoredSegments: [...context.authoredSegments, id],
        artifactPrefix: [...context.artifactPrefix, id],
        parent: context,
        id,
        pathBacked: false,
        physicalRoot: context.physicalRoot,
        children: [],
        childById: new Map<string, LoadedAnalysis>(),
        universes: [],
        universeById: new Map<string, LoadedUniverse>(),
        valid: context.valid,
      };
      await loadChildren(reader, child, issues, ancestry);
    }
    context.children.push(child);
    context.childById.set(id, child);
  }
}

function mapKeyIssue(
  key: string,
  value: Dict,
  file: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (value.id != null && value.id !== key) {
    pushIssue(issues, {
      code: "MAP_KEY_ID_MISMATCH",
      message: `Inline id ${JSON.stringify(value.id)} must match map key '${key}'`,
      file,
      path: `${path}.id`,
    });
  }
}

function validateMapAgreements(root: LoadedAnalysis, issues: ValidationIssue[]): void {
  for (const context of walkLoaded(root)) {
    if (!context.valid) continue;
    if (context.pathBacked
      && context.id
      && context.data.id != null
      && context.data.id !== context.id) {
      pushIssue(issues, {
        code: "MAP_KEY_ID_MISMATCH",
        message: `Analysis id ${JSON.stringify(context.data.id)} must match map key '${context.id}'`,
        file: context.file,
        path: "id",
      });
    }
    for (const field of ["decisions", "prior_insights", "findings"] as const) {
      for (const [id, raw] of Object.entries(asDict(context.data[field]) ?? {})) {
        const value = asDict(raw);
        if (!value) continue;
        const path = authoredPath(context, field, id)!;
        mapKeyIssue(id, value, context.file, path, issues);
        if (field === "decisions") {
          for (const [optionId, rawOption] of Object.entries(asDict(value.options) ?? {})) {
            const option = asDict(rawOption);
            if (option) mapKeyIssue(
              optionId,
              option,
              context.file,
              `${path}.options.${optionId}`,
              issues,
            );
          }
        }
      }
    }
    for (const [id, raw] of Object.entries(asDict(context.data.analyses) ?? {})) {
      const child = asDict(raw);
      if (!child) continue;
      const path = authoredPath(context, "analyses", id)!;
      if (typeof child.path === "string" && child.path) {
        const extra = Object.keys(child).filter((field) => field !== "path");
        if (extra.length) pushIssue(issues, {
          code: "PATH_FIELD_CONFLICT",
          message: `Analysis.path cannot be combined with ${extra.join(", ")}`,
          file: context.file,
          path,
        });
      } else {
        mapKeyIssue(id, child, context.file, path, issues);
      }
    }
  }

  const visitUniverseNode = (
    node: Universe | UniverseNode,
    file: string,
    path: string,
  ): void => {
    for (const [id, raw] of Object.entries(asDict(node.decisions) ?? {})) {
      const selection = asDict(raw);
      if (typeof selection?.decision_id === "string" && selection.decision_id !== id) {
        const selectionPath = `${path ? `${path}.` : ""}decisions.${id}`;
        pushIssue(issues, {
          code: "MAP_KEY_ID_MISMATCH",
          message: `Decision id ${JSON.stringify(selection.decision_id)} must match map key '${id}'`,
          file,
          path: `${selectionPath}.decision_id`,
        });
      }
    }
    for (const [id, raw] of Object.entries(node.analyses ?? {})) {
      const value = asDict(raw);
      if (!value) continue;
      const childPath = `${path ? `${path}.` : ""}analyses.${id}`;
      mapKeyIssue(id, value, file, childPath, issues);
      visitUniverseNode(raw, file, childPath);
    }
  };
  for (const context of walkLoaded(root)) {
    for (const universe of context.universes) {
      if (!universe.valid) continue;
      visitUniverseNode(universe.data, universe.file, "");
    }
  }
}

async function validateLoadedStructures(
  root: LoadedAnalysis,
  issues: ValidationIssue[],
): Promise<void> {
  for (const context of walkLoaded(root)) {
    if (context.valid && context === context.physicalRoot) {
      const structuralIssues = validateAnalysisStructure(context.data as unknown as Dict);
      if (structuralIssues.length) {
        for (const owned of walkLoaded(root)) {
          if (owned.physicalRoot === context) owned.valid = false;
        }
      }
      for (const issue of structuralIssues) {
        pushIssue(issues, { ...issue, file: context.file });
      }
    }
    for (const universe of context.universes) {
      if (!universe.valid) continue;
      const structuralIssues = validateUniverseStructure(universe.data as unknown as Dict);
      if (structuralIssues.length) universe.valid = false;
      for (const issue of structuralIssues) {
        pushIssue(issues, { ...issue, file: universe.file });
      }
    }
  }
}

function isEmptySelection(node: UniverseNode): boolean {
  return node.universe === undefined && node.decisions == null && node.analyses == null;
}

function universeChild(data: Universe | UniverseNode, id: string): UniverseNode {
  const analyses = asDict(data.analyses);
  if (!analyses || !Object.hasOwn(analyses, id)) return {};
  return asDict(analyses[id]) as unknown as UniverseNode ?? {};
}

function buildSelectionPlan(
  root: LoadedAnalysis,
  selection: Universe | undefined,
  sourceFile: string,
  effectiveUniverseId: string,
  issues: ValidationIssue[],
): SelectionPlan {
  const states = new Map<LoadedAnalysis, SelectionState>();
  const mode = selection ? "universe" : "defaults";

  const visit = (
    context: LoadedAnalysis,
    data: Universe | UniverseNode,
    file: string,
    pathPrefix: string,
    currentMode: "universe" | "defaults",
    currentUniverseId: string,
  ): void => {
    states.set(context, {
      data,
      file,
      pathPrefix,
      mode: currentMode,
      effectiveUniverseId: currentUniverseId,
    });
    const declaredChildren = asDict((data as unknown as Dict).analyses) ?? {};
    for (const [id, rawChild] of Object.entries(declaredChildren)) {
      if (!asDict(rawChild)) continue;
      if (!context.childById.has(id)) {
        const childPath = [pathPrefix, "analyses", id].filter(Boolean).join(".");
        pushIssue(issues, {
          code: "UNKNOWN_ANALYSIS",
          message: `Universe references unknown analysis '${id}'`,
          file,
          path: childPath,
        });
      }
    }
    for (const child of context.children) {
      const childId = child.id!;
      const childSelection = universeChild(data, childId);
      const childPath = [pathPrefix, "analyses", childId].filter(Boolean).join(".");
      if (typeof childSelection.universe === "string") {
        if (!child.pathBacked) {
          pushIssue(issues, {
            code: "UNSUPPORTED_INLINE_UNIVERSE_REFERENCE",
            message: `Inline analysis '${analysisPath(child)}' cannot select a named universe`,
            file,
            path: `${childPath}.universe`,
          });
          visit(child, {}, file, childPath, currentMode, currentUniverseId);
          continue;
        }
        if (childSelection.decisions != null || childSelection.analyses != null) {
          pushIssue(issues, {
            code: "UNIVERSE_REFERENCE_CONFLICT",
            message: "universe is mutually exclusive with inline decisions and analyses",
            file,
            path: childPath,
          });
        }
        const named = child.universeById.get(childSelection.universe);
        if (!named) {
          pushIssue(issues, {
            code: "UNIVERSE_NOT_FOUND",
            message: `Universe '${childSelection.universe}' was not found beside ${child.file}`,
            file,
            path: `${childPath}.universe`,
          });
          visit(child, {}, file, childPath, currentMode, currentUniverseId);
          continue;
        }
        visit(child, named.data, named.file, "", "universe", named.id);
      } else if (child.pathBacked && isEmptySelection(childSelection) && child.universes[0]) {
        // A path-backed analysis is a project of its own. When nothing here
        // configures it, it keeps its own implicit selection — the first
        // universe beside its astra.yaml, the same rule a root follows — so
        // its artifacts resolve under the results/<universe>/ its own runs
        // wrote, rather than under a universe id it never declared.
        const own = child.universes[0];
        visit(child, own.data, own.file, "", "universe", own.id);
      } else {
        visit(
          child,
          childSelection,
          file,
          childPath,
          currentMode,
          currentUniverseId,
        );
      }
    }
  };

  visit(root, selection ?? {}, sourceFile, "", mode, effectiveUniverseId);
  return { states };
}

function localInputs(context: LoadedAnalysis): Input[] {
  return Array.isArray(context.data.inputs) ? context.data.inputs : [];
}

function localOutputs(context: LoadedAnalysis): Output[] {
  return Array.isArray(context.data.outputs) ? context.data.outputs : [];
}

function localDecisions(context: LoadedAnalysis): Record<string, Decision> {
  const decisions = emptyRecord<Decision>();
  for (const [id, raw] of Object.entries(asDict(context.data.decisions) ?? {})) {
    const decision = asDict(raw);
    if (decision) decisions[id] = decision as unknown as Decision;
  }
  return decisions;
}

function decisionOptions(decision: Decision): Record<string, Option> {
  const options = emptyRecord<Option>();
  for (const [id, raw] of Object.entries(asDict(decision.options) ?? {})) {
    if (typeof raw === "string") options[id] = { label: raw };
    else {
      const option = asDict(raw);
      if (option) options[id] = option as unknown as Option;
    }
  }
  return options;
}

function decisionSelections(node: Universe | UniverseNode): Record<string, string> {
  const selections = emptyRecord<string>();
  for (const [id, raw] of Object.entries(asDict(node.decisions) ?? {})) {
    const optionId = typeof raw === "string" ? raw : asDict(raw)?.option_id;
    if (typeof optionId === "string") selections[id] = optionId;
  }
  return selections;
}

function localInsights(
  context: LoadedAnalysis,
  collection: "prior_insights" | "findings",
): Record<string, Insight> {
  const insights = emptyRecord<Insight>();
  for (const [id, raw] of Object.entries(asDict(context.data[collection]) ?? {})) {
    const insight = asDict(raw);
    if (insight) insights[id] = insight as unknown as Insight;
  }
  return insights;
}

function findById<T extends { id: string }>(items: T[], id: string): T | undefined {
  return items.find((item) => item.id === id);
}

function parseUpwardReference(reference: string): { up: number; rest: string[] } | undefined {
  let up = 0;
  let remaining = reference;
  while (remaining.startsWith("../")) {
    up += 1;
    remaining = remaining.slice(3);
  }
  const rest = remaining.split(".");
  if (!up || rest.some((part) => !ID_PATTERN.test(part))) return undefined;
  return { up, rest };
}

interface TemplateField {
  field: string;
  formatSpec: string;
  conversion: string | undefined;
}

function* iterTemplateFields(command: string): Generator<TemplateField> {
  let index = 0;
  while (index < command.length) {
    const character = command[index]!;
    if (character === "{") {
      if (command[index + 1] === "{") {
        index += 2;
        continue;
      }
      const end = command.indexOf("}", index + 1);
      if (end < 0) throw new Error("Single '{' encountered in format string");
      let field = command.slice(index + 1, end);
      let conversion: string | undefined;
      let formatSpec = "";
      const colon = field.indexOf(":");
      if (colon >= 0) {
        formatSpec = field.slice(colon + 1);
        field = field.slice(0, colon);
      }
      const bang = field.indexOf("!");
      if (bang >= 0) {
        conversion = field.slice(bang + 1);
        field = field.slice(0, bang);
      }
      yield { field, formatSpec, conversion };
      index = end + 1;
    } else if (character === "}") {
      if (command[index + 1] === "}") {
        index += 2;
        continue;
      }
      throw new Error("Single '}' encountered in format string");
    } else {
      index += 1;
    }
  }
}

function detectOutputCycle(graph: Map<string, string[]>): string[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    visiting.add(id);
    path.push(id);
    for (const dependency of graph.get(id) ?? []) {
      if (visiting.has(dependency)) {
        const start = path.indexOf(dependency);
        return [...path.slice(start), dependency];
      }
      if (!visited.has(dependency)) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };
  for (const id of graph.keys()) {
    if (!visited.has(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return undefined;
}

class ProjectCompiler {
  private readonly selectedMemo = new Map<Decision, string | undefined>();
  private readonly defaultSelectionsMemo = new Map<LoadedAnalysis, Record<string, string>>();
  private readonly unstableDefaultContexts = new Set<LoadedAnalysis>();
  private readonly decisionActiveMemo = new Map<Decision, boolean>();
  private readonly outputActiveMemo = new Map<Output, boolean>();

  constructor(
    private readonly root: LoadedAnalysis,
    private readonly plan: SelectionPlan | undefined,
    private readonly issues: ValidationIssue[],
    private readonly links: ProjectLinks,
  ) {}

  /** Link and validate every configuration-independent authored reference once. */
  validateProject(): void {
    for (const context of walkLoaded(this.root)) {
      if (!context.valid) continue;
      this.validateRequiredFields(context);
      this.validateDuplicateIds(context);
      for (const input of localInputs(context)) if (input.from) this.resolveInputAlias(context, input);
      for (const output of localOutputs(context)) if (output.from) this.resolveOutputAlias(context, output);
      for (const decision of Object.values(localDecisions(context))) {
        if (decision.from) this.resolveDecisionAlias(context, decision);
      }
      this.validateDecisions(context);
      for (const output of localOutputs(context)) {
        if (!output.from) this.linkOutputProvenance(context, output);
        this.linkConditions(context, output, "Output");
        const command = output.recipe?.command;
        if (typeof command === "string" && command) {
          this.validateCommandTemplate(
            context,
            command,
            new Set(output.inputs ?? []),
            new Set(output.decisions ?? []),
            `${authoredPath(context, "outputs", output.id)}.recipe.command`,
          );
        }
      }
      for (const [id, decision] of Object.entries(localDecisions(context))) {
        this.linkConditions(context, decision, "Decision", id);
      }
      this.validateInsights(context);
    }
    this.validateOutputCycles();
  }

  /** Validate one universe/default configuration using the prelinked project. */
  validateConfiguration(): void {
    for (const context of this.configuration.states.keys()) {
      this.validateSelectionReferences(context);
      this.validateSelection(context);
    }
    this.validateArtifactPaths();
  }

  /** Validate the context-independent references in a nested universe file. */
  validateUniverseReferences(): void {
    for (const context of this.configuration.states.keys()) {
      this.validateSelectionReferences(context);
    }
    this.validateArtifactPaths();
  }

  private get configuration(): SelectionPlan {
    if (!this.plan) throw new Error("A selection plan is required for configuration evaluation");
    return this.plan;
  }

  private error(
    context: LoadedAnalysis,
    code: string,
    message: string,
    path?: string,
    file = context.file,
  ): void {
    pushIssue(this.issues, { code, message, file, path });
  }

  private validateRequiredFields(context: LoadedAnalysis): void {
    if (context === context.physicalRoot) {
      for (const field of ["version", "name", "inputs", "outputs"] as const) {
        if (context.data[field] == null) {
          this.error(
            context,
            "MISSING_ROOT_FIELD",
            `Root analysis is missing required field '${field}'`,
            field,
          );
        }
      }
      return;
    }
    for (const field of ["inputs", "outputs"] as const) {
      if (context.data[field] == null) {
        this.error(
          context,
          "MISSING_SUB_FIELD",
          `Sub-analysis '${context.id}' is missing required field: ${field}`,
          `${authoredPath(context)}.${field}`,
        );
      }
    }
  }

  private validateDecisions(context: LoadedAnalysis): void {
    const rawDecisions = asDict(context.data.decisions) ?? {};
    const decisions = localDecisions(context);
    for (const [id, raw] of Object.entries(rawDecisions)) {
      const path = authoredPath(context, "decisions", id);
      const decision = asDict(raw) as unknown as Decision | undefined;
      if (!decision) {
        this.error(
          context,
          "MISSING_DECISION_DEFINITION",
          `Decision '${id}' has no definition`,
          path,
        );
        continue;
      }
      if (decision.from) continue;

      const options = decisionOptions(decision);
      if (decision.default != null && !options[decision.default]) {
        this.error(
          context,
          "INVALID_DEFAULT",
          `Default option '${decision.default}' not found in options`,
          path,
        );
      }

      const linkedOptions = new Map<string, OptionLinks>();
      const linkedInsightPaths = new Map<string, string[]>();
      for (const [optionId, option] of Object.entries(options)) {
        const optionPath = `${path}.options.${optionId}`;
        const insightPaths: string[] = [];
        for (const [index, insightId] of (option.insights ?? []).entries()) {
          const linked = this.resolveOptionInsight(
            context,
            insightId,
            `${optionPath}.insights[${index}]`,
          );
          if (linked) insightPaths.push(linked);
        }
        linkedInsightPaths.set(optionId, insightPaths);

        const links: OptionLinks = { incompatible: [], required: [] };
        for (const reference of option.incompatible_with ?? []) {
          const linked = this.linkConstraint(context, decisions, reference, optionPath);
          if (linked) links.incompatible.push(linked);
        }
        for (const reference of option.requires ?? []) {
          const linked = this.linkConstraint(context, decisions, reference, optionPath);
          if (linked) links.required.push(linked);
        }
        linkedOptions.set(optionId, links);

        if (option.excluded === true && !option.excluded_reason) {
          this.error(
            context,
            "MISSING_EXCLUDED_REASON",
            `Excluded option '${optionId}' must have an 'excluded_reason'`,
            optionPath,
          );
        }
        if (option.excluded_reason && option.excluded !== true) {
          this.error(
            context,
            "ORPHAN_EXCLUDED_REASON",
            `Option '${optionId}' has 'excluded_reason' but is not marked excluded`,
            optionPath,
          );
        }
      }
      this.links.optionConstraints.set(decision, linkedOptions);
      this.links.optionInsightPaths.set(decision, linkedInsightPaths);

      if (decision.default != null && options[decision.default]?.excluded === true) {
        this.error(
          context,
          "EXCLUDED_DEFAULT",
          `Default option '${decision.default}' is marked as excluded`,
          path,
        );
      }
    }
  }

  private resolveOptionInsight(
    context: LoadedAnalysis,
    reference: string,
    path: string,
  ): string | undefined {
    let owner: LoadedAnalysis | undefined = context;
    let insightId = reference;
    if (ID_PATTERN.test(reference)) {
      insightId = reference;
    } else {
      const parsed = parseUpwardReference(reference);
      if (!parsed || parsed.rest.length !== 1) {
        this.error(
          context,
          "INVALID_INSIGHT_REF",
          `Option insight '${reference}' must be a local id or an ancestor path such as '../id'`,
          path,
        );
        return undefined;
      }
      for (let count = 0; count < parsed.up; count += 1) owner = owner?.parent;
      insightId = parsed.rest[0]!;
      if (!owner) {
        this.error(
          context,
          "INVALID_INSIGHT_REF",
          `Option insight '${reference}' escapes the analysis tree`,
          path,
        );
        return undefined;
      }
    }
    if (!localInsights(owner, "prior_insights")[insightId]) {
      this.error(
        context,
        "INVALID_INSIGHT_REF",
        `Option insight '${reference}' not found in the referenced prior_insights scope`,
        path,
      );
      return undefined;
    }
    return recordPath(owner, "prior_insights", insightId);
  }

  private linkConstraint(
    context: LoadedAnalysis,
    decisions: Record<string, Decision>,
    reference: string,
    path: string,
  ): ConstraintLink | undefined {
    const parts = reference.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      this.error(
        context,
        "INVALID_CONSTRAINT_FORMAT",
        `Constraint '${reference}' should be in 'decision.option' format`,
        path,
      );
      return undefined;
    }
    const [decisionId, optionId] = parts as [string, string];
    const decision = decisions[decisionId];
    if (!decision) {
      this.error(
        context,
        "INVALID_CONSTRAINT_REF",
        `Constraint ref '${reference}' points to non-existent decision '${decisionId}'`,
        path,
      );
      return undefined;
    }
    const effective = decision.from
      ? this.resolveDecisionAlias(context, decision)?.value
      : decision;
    if (!effective || !decisionOptions(effective)[optionId]) {
      this.error(
        context,
        "INVALID_CONSTRAINT_REF",
        `Constraint ref '${reference}' points to non-existent option '${optionId}'`,
        path,
      );
      return undefined;
    }
    return { reference, decision, optionId };
  }

  private linkConditions(
    context: LoadedAnalysis,
    owner: Decision | Output,
    ownerKind: "Decision" | "Output",
    forbidSelfRef?: string,
  ): void {
    const links: ConditionLink[] = [];
    const path = authoredPath(
      context,
      ownerKind === "Decision" ? "decisions" : "outputs",
      owner.id,
    );
    for (const condition of owner.when ?? []) {
      const negated = condition.startsWith("~");
      const reference = negated ? condition.slice(1) : condition;
      const parts = reference.split(".");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        this.error(
          context,
          "INVALID_WHEN_REF",
          `${ownerKind} 'when' condition '${condition}' has invalid format`,
          path,
        );
        continue;
      }
      const [decisionId, optionId] = parts as [string, string];
      const decision = localDecisions(context)[decisionId];
      if (!decision) {
        const subject = ownerKind === "Output" ? "Output 'when'" : "'when'";
        this.error(
          context,
          "INVALID_WHEN_REF",
          `${subject} references non-existent decision '${decisionId}'`,
          path,
        );
        continue;
      }
      const effective = decision.from
        ? this.resolveDecisionAlias(context, decision)?.value
        : decision;
      if (!effective || !decisionOptions(effective)[optionId]) {
        const subject = ownerKind === "Output" ? "Output 'when'" : "'when'";
        this.error(
          context,
          "INVALID_WHEN_REF",
          `${subject} references non-existent option '${optionId}' in decision '${decisionId}'`,
          path,
        );
        continue;
      }
      if (forbidSelfRef === decisionId) {
        this.error(context, "INVALID_WHEN_REF", "'when' cannot reference own decision", path);
        continue;
      }
      links.push({ decision, optionId, negated });
    }
    this.links.conditions.set(owner, links);
  }

  private validateOutputCycles(): void {
    const owners = new Map<string, { context: LoadedAnalysis; output: Output }>();
    const graph = new Map<string, string[]>();
    for (const context of walkLoaded(this.root)) {
      if (!context.valid) continue;
      for (const output of localOutputs(context)) {
        if (output.from) continue;
        const path = recordPath(context, "outputs", output.id);
        owners.set(path, { context, output });
        graph.set(path, []);
      }
    }
    for (const [path] of graph) {
      const provenance = this.links.outputProvenance.get(owners.get(path)!.output);
      graph.set(
        path,
        (provenance?.inputPaths ?? []).filter((dependency) => graph.has(dependency)),
      );
    }
    const cycle = detectOutputCycle(graph);
    if (cycle) {
      const owner = owners.get(cycle[0]!)!;
      this.error(
        owner.context,
        "OUTPUT_CYCLE",
        `Dependency cycle detected: ${cycle.join(" -> ")}`,
        authoredPath(owner.context, "outputs", owner.output.id),
      );
    }
  }

  private validateCommandTemplate(
    context: LoadedAnalysis,
    command: string,
    declaredInputs: Set<string>,
    declaredDecisions: Set<string>,
    path: string,
  ): void {
    let fields: TemplateField[];
    try {
      fields = [...iterTemplateFields(command)];
    } catch (error) {
      this.error(context, "INVALID_COMMAND_TEMPLATE", causeMessage(error), path);
      return;
    }
    for (const { field, formatSpec, conversion } of fields) {
      if (field === "" || formatSpec || conversion) {
        this.error(
          context,
          "INVALID_COMMAND_TEMPLATE",
          `Invalid command placeholder '{${field}}'`,
          path,
        );
        continue;
      }
      if (field === "output" || field === "inputs") continue;
      const dot = field.indexOf(".");
      if (dot >= 0) {
        const head = field.slice(0, dot);
        const tail = field.slice(dot + 1);
        const declared = head === "inputs"
          ? declaredInputs
          : head === "decisions"
            ? declaredDecisions
            : undefined;
        if (declared && !tail.includes(".")) {
          if (!declared.has(tail)) {
            const singular = head === "inputs" ? "input" : "decision";
            this.error(
              context,
              "UNDECLARED_TEMPLATE_REF",
              `Command placeholder '{${field}}' references undeclared ${singular} '${tail}' (add it to Output.${head})`,
              path,
            );
          }
          continue;
        }
      }
      this.error(
        context,
        "INVALID_COMMAND_TEMPLATE",
        `Unknown command placeholder '{${field}}' (use {inputs}, {inputs.<id>}, {decisions.<id>}, or {output})`,
        path,
      );
    }
  }

  private validateDuplicateIds(context: LoadedAnalysis): void {
    for (const [collection, items] of [
      ["inputs", localInputs(context)],
      ["outputs", localOutputs(context)],
    ] as const) {
      const seen = new Set<string>();
      for (const item of items) {
        if (!item?.id) continue;
        if (seen.has(item.id)) {
          this.error(
            context,
            collection === "inputs" ? "DUPLICATE_INPUT" : "DUPLICATE_OUTPUT",
            `Duplicate ${collection.slice(0, -1)} id '${item.id}'`,
            authoredPath(context, collection, item.id),
          );
        }
        seen.add(item.id);
      }
    }
  }

  private descend(
    context: LoadedAnalysis,
    segments: string[],
  ): LoadedAnalysis | undefined {
    let current = context;
    for (const segment of segments) {
      const next = current.childById.get(segment);
      if (!next) return undefined;
      current = next;
    }
    return current;
  }

  private resolveInputAlias(
    context: LoadedAnalysis,
    input: Input,
  ): AliasTarget<Input | Output> | undefined {
    const cached = this.links.inputAliases.get(input);
    if (cached) return cached;
    const path = authoredPath(context, "inputs", input.id);
    const parsed = parseUpwardReference(input.from ?? "");
    let owner: LoadedAnalysis | undefined = context;
    if (parsed) for (let count = 0; count < parsed.up; count += 1) owner = owner?.parent;
    if (!parsed || !owner) {
      this.error(context, "INVALID_FROM", `Invalid input alias '${input.from}'`, path);
      return undefined;
    }
    let target: Input | Output | undefined;
    let targetContext: LoadedAnalysis | undefined = owner;
    if (parsed.rest.length === 1) {
      target = findById(localInputs(owner), parsed.rest[0]!);
    } else {
      targetContext = this.descend(owner, parsed.rest.slice(0, -1));
      target = targetContext
        ? findById(localOutputs(targetContext), parsed.rest.at(-1)!)
        : undefined;
    }
    let targetIsInOwnTree = false;
    if (target && parsed.rest.length > 1) {
      for (let current: LoadedAnalysis | undefined = targetContext; current; current = current.parent) {
        if (current === context) {
          targetIsInOwnTree = true;
          break;
        }
      }
    }
    if (targetIsInOwnTree) {
      this.error(
        context,
        "INVALID_FROM",
        `Input alias '${input.from}' cannot reference an output in its own analysis tree`,
        path,
      );
      return undefined;
    }
    if (!target || !targetContext) {
      this.error(
        context,
        "INVALID_FROM",
        `Input alias target '${input.from}' does not exist`,
        path,
      );
      return undefined;
    }
    const targetIsInput = localInputs(targetContext).includes(target as Input);
    const resolved = targetIsInput && (target as Input).from
      ? this.resolveInputAlias(targetContext, target as Input)
      : !targetIsInput && (target as Output).from
        ? this.resolveOutputAlias(targetContext, target as Output)
        : {
            context: targetContext,
            value: target,
            canonicalPath: recordPath(
              targetContext,
              localInputs(targetContext).includes(target as Input) ? "inputs" : "outputs",
              target.id,
            ),
          };
    if (resolved) this.links.inputAliases.set(input, resolved);
    return resolved;
  }

  private resolveOutputAlias(
    context: LoadedAnalysis,
    output: Output,
  ): AliasResolution<Output> | undefined {
    const cached = this.links.outputAliases.get(output);
    if (cached) return cached;
    const path = authoredPath(context, "outputs", output.id);
    const reference = output.from ?? "";
    const parts = reference.split(".");
    if (reference.startsWith("../") || parts.length < 2 || parts.some((part) => !ID_PATTERN.test(part))) {
      this.error(context, "INVALID_OUTPUT_FROM", `Invalid output alias '${reference}'`, path);
      return undefined;
    }
    const targetContext = this.descend(context, parts.slice(0, -1));
    const target = targetContext
      ? findById(localOutputs(targetContext), parts.at(-1)!)
      : undefined;
    if (!target || !targetContext) {
      this.error(
        context,
        "INVALID_OUTPUT_FROM",
        `Output alias target '${reference}' does not exist`,
        path,
      );
      return undefined;
    }
    const immediate = {
      context: targetContext,
      value: target,
      canonicalPath: recordPath(targetContext, "outputs", target.id),
    };
    const ultimate = target.from
      ? this.resolveOutputAlias(targetContext, target)
      : immediate;
    const resolved = ultimate
      ? {
          context: ultimate.context,
          value: ultimate.value,
          canonicalPath: ultimate.canonicalPath,
          immediate,
        }
      : undefined;
    if (resolved) this.links.outputAliases.set(output, resolved);
    return resolved;
  }

  private resolveDecisionAlias(
    context: LoadedAnalysis,
    decision: Decision,
  ): AliasResolution<Decision> | undefined {
    const cached = this.links.decisionAliases.get(decision);
    if (cached) return cached;
    const path = authoredPath(context, "decisions", decision.id);
    const parsed = parseUpwardReference(decision.from ?? "");
    let owner: LoadedAnalysis | undefined = context;
    if (parsed) for (let count = 0; count < parsed.up; count += 1) owner = owner?.parent;
    const targetId = parsed?.rest.length === 1 ? parsed.rest[0] : undefined;
    const target = owner && targetId ? localDecisions(owner)[targetId] : undefined;
    if (!parsed || !owner || !target) {
      this.error(
        context,
        "INVALID_DECISION_FROM",
        `Decision alias target '${decision.from}' does not exist`,
        path,
      );
      return undefined;
    }
    const immediate = {
      context: owner,
      value: target,
      canonicalPath: recordPath(owner, "decisions", targetId!),
    };
    const ultimate = target.from
      ? this.resolveDecisionAlias(owner, target)
      : immediate;
    const resolved = ultimate
      ? {
          context: ultimate.context,
          value: ultimate.value,
          canonicalPath: ultimate.canonicalPath,
          immediate,
        }
      : undefined;
    if (resolved) this.links.decisionAliases.set(decision, resolved);
    return resolved;
  }

  private selectedOption(context: LoadedAnalysis, decision: Decision): string | undefined {
    if (this.selectedMemo.has(decision)) return this.selectedMemo.get(decision);
    let selected: string | undefined;
    if (decision.from) {
      const target = this.links.decisionAliases.get(decision);
      selected = target ? this.selectedOption(target.context, target.value) : undefined;
    } else {
      const state = this.configuration.states.get(context);
      selected = state?.mode === "defaults"
        ? this.defaultSelections(context)[decision.id!]
        : state && decisionSelections(state.data)[decision.id!];
    }
    this.selectedMemo.set(decision, selected);
    return selected;
  }

  private defaultSelections(context: LoadedAnalysis): Record<string, string> {
    const cached = this.defaultSelectionsMemo.get(context);
    if (cached) return cached;

    const decisions = localDecisions(context);
    let selected = emptyRecord<string>();
    const seen = new Set<string>();
    while (true) {
      const stateKey = JSON.stringify(Object.entries(selected).sort(([left], [right]) =>
        left.localeCompare(right)));
      if (seen.has(stateKey)) {
        this.error(
          context,
          "UNSTABLE_DEFAULT_SELECTIONS",
          "Conditional decision defaults do not settle to a stable configuration",
          authoredPath(context, "decisions"),
        );
        this.unstableDefaultContexts.add(context);
        selected = emptyRecord<string>();
        break;
      }
      seen.add(stateKey);

      const next = emptyRecord<string>();
      for (const [id, decision] of Object.entries(decisions)) {
        if (decision.from || decision.default === undefined) continue;
        const active = !decision.when?.length
          || (this.links.conditions.get(decision) ?? []).every((condition) => {
            const actual = condition.decision.from
              ? this.selectedOption(context, condition.decision)
              : selected[condition.decision.id!];
            const matches = actual === condition.optionId;
            return condition.negated ? !matches : matches;
          });
        if (active) next[id] = decision.default;
      }
      const nextKey = JSON.stringify(Object.entries(next).sort(([left], [right]) =>
        left.localeCompare(right)));
      if (nextKey === stateKey) {
        selected = next;
        break;
      }
      selected = next;
    }
    this.defaultSelectionsMemo.set(context, selected);
    return selected;
  }

  private conditionMet(
    context: LoadedAnalysis,
    owner: Decision | Output,
  ): boolean {
    if (!owner.when) return true;
    let active = true;
    for (const condition of this.links.conditions.get(owner) ?? []) {
      const matches = this.selectedOption(context, condition.decision) === condition.optionId;
      if (condition.negated ? matches : !matches) active = false;
    }
    return active;
  }

  private decisionActive(context: LoadedAnalysis, decision: Decision): boolean {
    const cached = this.decisionActiveMemo.get(decision);
    if (cached !== undefined) return cached;
    const own = this.conditionMet(context, decision);
    const target = decision.from
      ? this.links.decisionAliases.get(decision)?.immediate
      : undefined;
    const active = own && (!target || this.decisionActive(target.context, target.value));
    this.decisionActiveMemo.set(decision, active);
    return active;
  }

  private outputActive(context: LoadedAnalysis, output: Output): boolean {
    const cached = this.outputActiveMemo.get(output);
    if (cached !== undefined) return cached;
    const own = this.conditionMet(context, output);
    const target = output.from
      ? this.links.outputAliases.get(output)?.immediate
      : undefined;
    const active = own && (!target || this.outputActive(target.context, target.value));
    this.outputActiveMemo.set(output, active);
    return active;
  }

  private validateSelectionReferences(context: LoadedAnalysis): void {
    const state = this.configuration.states.get(context)!;
    const selections = decisionSelections(state.data);
    const decisions = localDecisions(context);
    const selectionPath = (id: string): string =>
      [state.pathPrefix, "decisions", id].filter(Boolean).join(".");
    for (const id of Object.keys(selections)) {
      const decision = decisions[id];
      if (!decision) {
        this.error(
          context,
          "UNKNOWN_DECISION",
          `Universe references unknown decision '${id}'`,
          selectionPath(id),
          state.file,
        );
      } else if (decision.from) {
        this.error(
          context,
          "FROM_DECISION_IN_UNIVERSE",
          `Universe must not select aliased decision '${id}'`,
          selectionPath(id),
          state.file,
        );
      } else {
        const selected = selections[id]!;
        const option = decisionOptions(decision)[selected];
        if (!option) {
          this.error(
            context,
            "UNKNOWN_OPTION",
            `Decision '${id}' has no option '${selected}'`,
            selectionPath(id),
            state.file,
          );
        } else if (option.excluded) {
          this.error(
            context,
            "EXCLUDED_OPTION_SELECTED",
            `Option '${id}.${selected}' is excluded`,
            selectionPath(id),
            state.file,
          );
        }
      }
    }
  }

  private validateSelection(context: LoadedAnalysis): void {
    const state = this.configuration.states.get(context)!;
    if (state.mode === "defaults") {
      this.defaultSelections(context);
      if (this.unstableDefaultContexts.has(context)) return;
    }
    const selections = decisionSelections(state.data);
    const decisions = localDecisions(context);
    const selectionPath = (id: string): string =>
      [state.pathPrefix, "decisions", id].filter(Boolean).join(".");
    for (const [id, decision] of Object.entries(decisions)) {
      if (decision.from) continue;
      const active = this.decisionActive(context, decision);
      const selected = this.selectedOption(context, decision);
      const decisionSelectionPath = selectionPath(id);
      if (!active) {
        if (state.mode === "universe" && id in selections) {
          this.error(
            context,
            "INACTIVE_DECISION",
            `Universe selects inactive decision '${id}'`,
            decisionSelectionPath,
            state.file,
          );
        }
        continue;
      } else if (!selected) {
        this.error(
          context,
          "MISSING_DECISION_SELECTION",
          state.mode === "defaults"
            ? `Active decision '${id}' has no default`
            : `Universe does not select active decision '${id}'`,
          state.mode === "defaults"
            ? authoredPath(context, "decisions", id)
            : decisionSelectionPath,
          state.mode === "defaults" ? context.file : state.file,
        );
      }
      const option = selected ? decisionOptions(decision)[selected] : undefined;
      if (!selected || !option) continue;
      const constraints = this.links.optionConstraints.get(decision)?.get(selected);
      const constraintPath = state.mode === "defaults"
        ? authoredPath(context, "decisions", id)
        : selectionPath(id);
      const constraintFile = state.mode === "defaults" ? context.file : state.file;
      for (const link of constraints?.incompatible ?? []) {
        if (this.selectedOption(context, link.decision) === link.optionId) {
          this.error(
            context,
            "INCOMPATIBLE_OPTIONS",
            `Option '${id}.${selected}' is incompatible with '${link.reference}'`,
            constraintPath,
            constraintFile,
          );
        }
      }
      for (const link of constraints?.required ?? []) {
        if (this.selectedOption(context, link.decision) !== link.optionId) {
          this.error(
            context,
            "MISSING_REQUIRED_OPTION",
            `Option '${id}.${selected}' requires '${link.reference}'`,
            constraintPath,
            constraintFile,
          );
        }
      }
    }
  }

  private linkOutputProvenance(
    context: LoadedAnalysis,
    output: Output,
  ): OutputProvenance {
    const inputPaths: string[] = [];
    for (const id of output.inputs ?? []) {
      const input = findById(localInputs(context), id);
      const siblingOutput = findById(localOutputs(context), id);
      // Match the canonical resolver: a sibling output wins an ambiguous ID.
      if (siblingOutput) {
        const target = siblingOutput.from
          ? this.links.outputAliases.get(siblingOutput)
            ?? this.resolveOutputAlias(context, siblingOutput)
          : undefined;
        inputPaths.push(target?.canonicalPath ?? recordPath(context, "outputs", id));
      } else if (input) {
        const target = input.from
          ? this.links.inputAliases.get(input) ?? this.resolveInputAlias(context, input)
          : undefined;
        inputPaths.push(target?.canonicalPath ?? recordPath(context, "inputs", id));
      } else {
        const parts = id.split(".");
        const child = parts.length === 2 ? context.childById.get(parts[0]!) : undefined;
        const childOutput = child ? findById(localOutputs(child), parts[1]!) : undefined;
        if (child && childOutput) {
          const target = childOutput.from
            ? this.links.outputAliases.get(childOutput)
              ?? this.resolveOutputAlias(child, childOutput)
            : undefined;
          inputPaths.push(target?.canonicalPath ?? recordPath(child, "outputs", childOutput.id));
        } else {
          this.error(
            context,
            "INVALID_OUTPUT_INPUT",
            `Output input '${id}' is not a declared analysis input or sibling output`,
            `${authoredPath(context, "outputs", output.id)}.inputs`,
          );
        }
      }
    }
    const decisionPaths: string[] = [];
    for (const id of output.decisions ?? []) {
      const decision = localDecisions(context)[id];
      if (!decision) {
        this.error(
          context,
          "INVALID_OUTPUT_DECISION",
          `Output decision '${id}' is not a decision in scope`,
          `${authoredPath(context, "outputs", output.id)}.decisions`,
        );
      } else {
        const target = decision.from
          ? this.links.decisionAliases.get(decision)
            ?? this.resolveDecisionAlias(context, decision)
          : undefined;
        decisionPaths.push(target?.canonicalPath ?? recordPath(context, "decisions", id));
      }
    }
    const provenance = { inputPaths, decisionPaths };
    this.links.outputProvenance.set(output, provenance);
    return provenance;
  }

  private validateInsights(context: LoadedAnalysis): void {
    for (const collection of ["prior_insights", "findings"] as const) {
      for (const [id, insight] of Object.entries(localInsights(context, collection))) {
        const evidencePaths = (Array.isArray(insight.evidence) ? insight.evidence : [])
          .map((evidence, index): string | undefined => {
            if (evidence.artifact === undefined) return undefined;
            const output = findById(localOutputs(context), evidence.artifact);
            if (!output) {
              this.error(
                context,
                "INVALID_ARTIFACT_REF",
                `Evidence artifact '${evidence.artifact}' not found in declared outputs`,
                `${authoredPath(context, collection, id)}.evidence[${index}].artifact`,
              );
              return undefined;
            }
            return recordPath(context, "outputs", output.id);
          });
        this.links.insightEvidencePaths.set(insight, evidencePaths);
      }
    }
  }

  private validateArtifactPaths(): void {
    const seen = new Map<string, string>();
    for (const context of this.configuration.states.keys()) {
      const universeId = this.configuration.states.get(context)!.effectiveUniverseId;
      for (const output of localOutputs(context)) {
        if (output.from || !output.format) continue;
        const name = `${[...context.artifactPrefix, output.id].join(".")}.${output.format}`;
        const key = `${context.directory}\0${universeId}\0${name}`;
        const outputPath = recordPath(context, "outputs", output.id);
        const previous = seen.get(key);
        if (previous) {
          const artifactPath = normalizedJoin(
            context.directory,
            "results",
            universeId,
            name,
          );
          this.error(
            context,
            "DUPLICATE_ARTIFACT_PATH",
            `Outputs '${previous}' and '${outputPath}' produce the same artifact path '${artifactPath}'`,
            authoredPath(context, "outputs", output.id),
          );
        } else {
          seen.set(key, outputPath);
        }
      }
    }
  }

  project(): ResolvedRootAnalysis {
    return this.projectAnalysis(this.root) as ResolvedRootAnalysis;
  }

  private projectAnalysis(context: LoadedAnalysis): ResolvedAnalysisNode {
    const {
      path: _path,
      inputs: _inputs,
      outputs: _outputs,
      decisions: _decisions,
      prior_insights: _priorInsights,
      findings: _findings,
      analyses: _analyses,
      ...metadata
    } = context.data;
    return {
      ...metadata,
      ...(context.id ? { id: context.id } : {}),
      canonicalPath: analysisPath(context),
      inputs: localInputs(context).map((input) => this.projectInput(context, input)),
      outputs: localOutputs(context).map((output) => this.projectOutput(context, output)),
      decisions: Object.entries(localDecisions(context)).map(([id, decision]) =>
        this.projectDecision(context, id, decision)),
      prior_insights: Object.entries(localInsights(context, "prior_insights")).map(([id, insight]) =>
        this.projectInsight(context, "prior_insight", id, insight)),
      findings: Object.entries(localInsights(context, "findings")).map(([id, insight]) =>
        this.projectInsight(context, "finding", id, insight)),
      analyses: context.children.map((child) => this.projectAnalysis(child) as ResolvedAnalysisNode & { id: string }),
    };
  }

  private projectInput(context: LoadedAnalysis, input: Input): ResolvedInput {
    const target = input.from ? this.links.inputAliases.get(input)! : undefined;
    if (!target) {
      return {
        ...input,
        canonicalPath: recordPath(context, "inputs", input.id),
        kind: "input",
        type: input.type!,
      };
    }
    const source = target.value;
    const inherited = localInputs(target.context).includes(source as Input)
      ? source as Input
      : {
          id: source.id,
          type: (source as Output).type,
          ...((source as Output).label !== undefined
            ? { label: (source as Output).label }
            : {}),
          ...((source as Output).description !== undefined
            ? { description: (source as Output).description }
            : {}),
        };
    return {
      ...inherited,
      id: input.id,
      from: input.from,
      canonicalPath: recordPath(context, "inputs", input.id),
      kind: "input",
      type: inherited.type!,
      resolvedFrom: target.canonicalPath,
    };
  }

  private projectOutput(context: LoadedAnalysis, output: Output): ResolvedOutput {
    const target = output.from ? this.links.outputAliases.get(output)! : undefined;
    const source = target?.value ?? output;
    const {
      id: _sourceId,
      from: _sourceFrom,
      when: _sourceWhen,
      ...sourceContent
    } = source;
    const projected: ResolvedOutput = {
      ...sourceContent,
      id: output.id,
      ...(output.from ? { from: output.from } : {}),
      ...(output.when !== undefined ? { when: output.when } : {}),
      canonicalPath: recordPath(context, "outputs", output.id),
      kind: "output",
      type: source.type!,
      active: this.outputActive(context, output),
      ...(target ? { resolvedFrom: target.canonicalPath } : {}),
      provenance: this.links.outputProvenance.get(source)!,
    };
    return projected;
  }

  private projectDecision(
    context: LoadedAnalysis,
    id: string,
    decision: Decision,
  ): ResolvedDecision {
    const target = decision.from ? this.links.decisionAliases.get(decision)! : undefined;
    const source = target?.value ?? decision;
    const {
      id: _sourceId,
      from: _sourceFrom,
      when: _sourceWhen,
      options: _sourceOptions,
      ...sourceContent
    } = source;
    const options = Object.entries(decisionOptions(source)).map(([id, option]) =>
      this.projectOption(source, id, option));
    const selectedOptionId = this.selectedOption(context, decision);
    return {
      ...sourceContent,
      id,
      ...(decision.from ? { from: decision.from } : {}),
      ...(decision.when !== undefined ? { when: decision.when } : {}),
      canonicalPath: recordPath(context, "decisions", id),
      kind: "decision",
      label: source.label!,
      active: this.decisionActive(context, decision),
      ...(target ? { resolvedFrom: target.canonicalPath } : {}),
      options,
      ...(selectedOptionId ? { selectedOptionId } : {}),
    };
  }

  private projectOption(
    decision: Decision,
    id: string,
    option: Option,
  ): ResolvedOption {
    return {
      ...option,
      id,
      resolvedInsightPaths: this.links.optionInsightPaths.get(decision)?.get(id) ?? [],
    };
  }

  private projectInsight(
    context: LoadedAnalysis,
    kind: "finding" | "prior_insight",
    id: string,
    insight: Insight,
  ): ResolvedInsight {
    const collection = kind === "finding" ? "findings" : "prior_insights";
    const evidencePaths = this.links.insightEvidencePaths.get(insight) ?? [];
    return {
      ...insight,
      id,
      canonicalPath: recordPath(context, collection, id),
      kind,
      evidence: insight.evidence.map((evidence, index): ResolvedEvidence => ({
        ...evidence,
        ...(evidencePaths[index]
          ? { resolvedOutputPath: evidencePaths[index] }
          : {}),
      })),
    };
  }

  artifactPath(context: LoadedAnalysis, output: Output): string | undefined {
    const target = output.from ? this.links.outputAliases.get(output) : undefined;
    const source = target?.value ?? output;
    const owner = target?.context ?? context;
    if (!source.format) return undefined;
    const state = this.configuration.states.get(owner);
    if (!state) return undefined;
    const filename = `${[...owner.artifactPrefix, source.id].join(".")}.${source.format}`;
    return normalizedJoin(owner.directory, "results", state.effectiveUniverseId, filename);
  }
}

async function sha256CacheToken(
  path: string,
  modifiedAtMs: number,
  byteSize: number,
): Promise<string> {
  try {
    if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is unavailable");
    const encoder = new TextEncoder();
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      encoder.encode(`${path}\0${modifiedAtMs}\0${byteSize}`),
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch (error) {
    throw new ProjectLoadError(
      "READ_FAILED",
      `Could not compute a cache token for ${path}: ${causeMessage(error)}`,
      path,
      error,
    );
  }
}

function walkLoaded(root: LoadedAnalysis): LoadedAnalysis[] {
  const result: LoadedAnalysis[] = [];
  const visit = (context: LoadedAnalysis): void => {
    result.push(context);
    for (const child of context.children) visit(child);
  };
  visit(root);
  return result;
}

async function bindArtifacts(
  reader: ProjectReader,
  root: LoadedAnalysis,
  projected: ResolvedAnalysisNode,
  resolver: ProjectCompiler,
): Promise<ArtifactBinding[]> {
  const bindings: ArtifactBinding[] = [];
  const outputByPath = new Map<string, ResolvedOutput>();
  const collectOutputs = (analysis: ResolvedAnalysisNode): void => {
    for (const output of analysis.outputs) outputByPath.set(output.canonicalPath, output);
    for (const child of analysis.analyses) collectOutputs(child);
  };
  collectOutputs(projected);
  const artifacts = new Map<string, { byteSize: number; cacheToken: string } | undefined>();
  for (const context of walkLoaded(root)) {
    for (const output of localOutputs(context)) {
      const canonicalPath = recordPath(context, "outputs", output.id);
      const resolvedOutput = outputByPath.get(canonicalPath)!;
      if (!resolvedOutput.active) continue;
      const path = resolver.artifactPath(context, output);
      if (!path) continue;
      let artifact = artifacts.get(path);
      if (!artifacts.has(path)) {
        const stat = await readStat(reader, path);
        artifact = stat?.type === "file"
          ? {
              byteSize: stat.size,
              cacheToken: await sha256CacheToken(path, stat.modifiedAtMs, stat.size),
            }
          : undefined;
        artifacts.set(path, artifact);
      }
      if (!artifact) continue;
      resolvedOutput.artifact = { byteSize: artifact.byteSize };
      bindings.push({
        outputPath: canonicalPath,
        path,
        cacheToken: artifact.cacheToken,
      });
    }
  }
  return bindings;
}

interface InvalidProjectCompilation {
  valid: false;
  issues: ValidationIssue[];
}

interface ValidProjectCompilation {
  valid: true;
  root: LoadedAnalysis;
  issues: ValidationIssue[];
  selected?: LoadedUniverse;
  source: "explicit" | "implicit" | "none";
  resolver: ProjectCompiler;
}

type ProjectCompilation = InvalidProjectCompilation | ValidProjectCompilation;

async function compileAnalysisProject(
  reader: ProjectReader,
  options: ResolveAnalysisOptions = {},
): Promise<ProjectCompilation> {
  const issues: ValidationIssue[] = [];
  const root = await loadAnalysisFile(reader, "astra.yaml", issues, {
    canonicalSegments: [],
    authoredSegments: [],
    artifactPrefix: [],
    pathBacked: false,
    ancestry: new Set<string>(),
  });
  validateMapAgreements(root, issues);
  await validateLoadedStructures(root, issues);
  const links = createProjectLinks();
  const linker = new ProjectCompiler(root, undefined, issues, links);
  linker.validateProject();
  if (issues.length) return { valid: false, issues };

  let selected: LoadedUniverse | undefined;
  let source: "explicit" | "implicit" | "none";
  if (options.universeId !== undefined) {
    selected = root.universeById.get(options.universeId);
    source = "explicit";
  } else {
    selected = root.universes[0];
    source = selected ? "implicit" : "none";
  }

  // A nested universe has no ancestor selections when it is not referenced by
  // a root configuration. Its names, option references, child links, and
  // deterministic artifact paths can still be validated independently.
  for (const context of walkLoaded(root).slice(1)) {
    for (const universe of context.universes) {
      if (!universe.valid) continue;
      const plan = buildSelectionPlan(context, universe.data, universe.file, universe.id, issues);
      new ProjectCompiler(context, plan, issues, links).validateUniverseReferences();
    }
  }

  // Evaluate every root configuration. Referenced nested universes are folded
  // into these plans with their ancestor selections intact. An unreferenced
  // nested universe has no meaningful ancestor configuration, so its activity,
  // required selections, and constraints are checked only when referenced.
  let selectedResolver: ProjectCompiler | undefined;
  for (const universe of root.universes) {
    if (!universe.valid) continue;
    const plan = buildSelectionPlan(root, universe.data, universe.file, universe.id, issues);
    const resolver = new ProjectCompiler(root, plan, issues, links);
    resolver.validateConfiguration();
    if (universe === selected) selectedResolver = resolver;
  }
  if (!root.universes.length) {
    const plan = buildSelectionPlan(root, undefined, "astra.yaml", "default", issues);
    selectedResolver = new ProjectCompiler(root, plan, issues, links);
    selectedResolver.validateConfiguration();
  }
  if (issues.length) return { valid: false, issues };
  if (options.universeId !== undefined && !selected) {
    throw new ProjectLoadError(
      "UNIVERSE_NOT_FOUND",
      `Root universe '${options.universeId}' does not exist`,
      normalizedJoin("universes", `${options.universeId}.yaml`),
    );
  }
  if (!selectedResolver) {
    throw new ProjectLoadError(
      "UNIVERSE_NOT_FOUND",
      "No resolvable root universe was found",
      "universes",
    );
  }
  return { valid: true, root, issues, selected, source, resolver: selectedResolver };
}

/** Validate one complete ASTRA project through a host adapter. */
export async function validateAnalysis(
  reader: ProjectReader,
): Promise<AnalysisValidationResult> {
  const compiled = await compileAnalysisProject(reader);
  return { valid: compiled.valid, issues: compiled.issues };
}

/** Load, validate, and resolve one ASTRA project through a host adapter. */
export async function resolveAnalysis(
  reader: ProjectReader,
  options: ResolveAnalysisOptions = {},
): Promise<ResolvedAnalysisBundle> {
  const compiled = await compileAnalysisProject(reader, options);
  if (!compiled.valid) throw new AnalysisValidationError(compiled.issues);
  const {
    root,
    selected,
    source,
    resolver: selectedResolver,
  } = compiled;

  const analysis = selectedResolver.project();
  const bindings = await bindArtifacts(reader, root, analysis, selectedResolver);
  return {
    document: {
      schemaVersion: RESOLVED_ANALYSIS_SCHEMA_VERSION,
      universe: {
        universeId: selected?.id ?? "default",
        ...(selected?.data.description !== undefined
          ? { description: selected.data.description }
          : {}),
        availableUniverseIds: root.universes.map((universe) => universe.id),
        source,
      },
      analysis,
    },
    bindings,
  };
}
