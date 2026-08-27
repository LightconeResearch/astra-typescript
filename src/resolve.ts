import { parse as parseYaml } from "yaml";

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
  getDecisionOptions,
  getDecisionSelections,
} from "./helpers.js";
import {
  validateAnalysis as validateAnalysisSemantics,
  validateAnalysisRootFields,
} from "./validation/semantic.js";
import {
  validateAnalysisStructure,
  validateUniverseStructure,
} from "./validation/schema.js";
import type { JsonSchema } from "./schema/index.js";

export interface ResolveOptions {
  /** Select this root universe instead of the first filename. */
  universeId?: string;
  /** Override the SDK's bundled structural schema. */
  schema?: JsonSchema;
}

export interface ValidationIssue {
  code: string;
  message: string;
  /** Project-relative YAML file containing the invalid value. */
  file: string;
  /** Path within the authored YAML document. */
  path?: string;
}

export class AnalysisValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(`Invalid ASTRA project (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
    this.name = "AnalysisValidationError";
    this.issues = issues;
  }
}

export type ResolveAnalysisErrorCode =
  | "PROJECT_NOT_FOUND"
  | "READ_FAILED"
  | "INVALID_YAML"
  | "UNIVERSE_NOT_FOUND"
  | "UNSUPPORTED_INLINE_UNIVERSE_REFERENCE"
  | "PROJECT_PATH_ESCAPE";

export class ResolveAnalysisError extends Error {
  readonly code: ResolveAnalysisErrorCode;
  readonly path?: string;

  constructor(code: ResolveAnalysisErrorCode, message: string, path?: string) {
    super(message);
    this.name = "ResolveAnalysisError";
    this.code = code;
    this.path = path;
  }
}

type Dict = Record<string, unknown>;

interface LoadedUniverse {
  data: Universe;
  file: string;
  filename: string;
  id: string;
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

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;

function asDict(value: unknown): Dict | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Dict
    : undefined;
}

function liftMapIds(data: Dict): void {
  for (const field of ["decisions", "prior_insights", "findings"] as const) {
    const mapping = asDict(data[field]);
    if (!mapping) continue;
    for (const [id, raw] of Object.entries(mapping)) {
      const value = asDict(raw);
      if (!value) continue;
      if (value.id == null) value.id = id;
      if (field === "decisions") {
        const options = asDict(value.options);
        if (options) for (const [optionId, rawOption] of Object.entries(options)) {
          const option = asDict(rawOption);
          if (option && option.id == null) option.id = optionId;
        }
      }
    }
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

function pathError(path: string, error: unknown): ResolveAnalysisError {
  return new ResolveAnalysisError(
    "PROJECT_PATH_ESCAPE",
    `Project path escapes the project root: ${path}. ${causeMessage(error)}`,
    path,
  );
}

function readerError(
  action: string,
  path: string,
  error: unknown,
): ResolveAnalysisError {
  if (error instanceof ProjectPathError) return pathError(path, error);
  return new ResolveAnalysisError(
    "READ_FAILED",
    `Could not ${action} ${path || "the project root"}: ${causeMessage(error)}`,
    path,
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
  let entry: ProjectEntry | undefined;
  try {
    entry = await reader.stat(path);
  } catch (error) {
    throw readerError("stat", path, error);
  }
  if (entry && !isValidProjectEntry(entry)) {
    throw new ResolveAnalysisError(
      "READ_FAILED",
      `Reader returned malformed metadata for ${path || "the project root"}`,
      path,
    );
  }
  return entry;
}

async function readDirectory(
  reader: ProjectReader,
  path: string,
): Promise<ProjectDirectoryEntry[]> {
  let entries: ProjectDirectoryEntry[];
  try {
    entries = await reader.readDirectory(path);
  } catch (error) {
    throw readerError("read directory", path, error);
  }
  for (const entry of entries) {
    if (!entry
      || typeof entry.name !== "string"
      || !entry.name
      || entry.name === "."
      || entry.name === ".."
      || entry.name.includes("/")
      || entry.name.includes("\\")
      || (entry.type !== "file" && entry.type !== "directory")) {
      throw new ResolveAnalysisError(
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
): Promise<Dict> {
  let text: string;
  try {
    text = await reader.readText(path);
  } catch (error) {
    throw readerError("read", path, error);
  }
  try {
    const parsed: unknown = parseYaml(text);
    const mapping = asDict(parsed);
    if (!mapping) throw new Error("YAML root must be a mapping/object");
    return mapping;
  } catch (error) {
    throw new ResolveAnalysisError(
      "INVALID_YAML",
      `Could not parse ${path}: ${causeMessage(error)}`,
      path,
    );
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
    throw new ResolveAnalysisError(
      "READ_FAILED",
      `Expected ${directory} to be a directory`,
      directory,
    );
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
    const data = await readMapping(reader, file);
    const id = typeof data.id === "string" ? data.id : stem;
    if (data.id !== stem) {
      pushIssue(issues, {
        code: "UNIVERSE_FILENAME_MISMATCH",
        message: `Universe id must match filename '${stem}'`,
        file,
        path: "id",
      });
    }
    const loaded = { data: data as unknown as Universe, file, filename, id };
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
  if (!stat || stat.type !== "file") {
    if (!options.parent) {
      throw new ResolveAnalysisError(
        "PROJECT_NOT_FOUND",
        "No astra.yaml file was found in the project root",
        file,
      );
    }
    throw new ResolveAnalysisError(
      "READ_FAILED",
      `Declared analysis file does not exist: ${file}`,
      file,
    );
  }
  const data = await readMapping(reader, file);
  liftMapIds(data);
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
  } satisfies LoadedAnalysis;
  context.physicalRoot = context;
  await loadUniverses(reader, context, issues);
  await loadChildren(reader, context, issues, new Set([...options.ancestry, file]));
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
      const directory = normalizedJoin(context.directory, childData.path);
      const file = normalizedJoin(directory, "astra.yaml");
      if (ancestry.has(file)) {
        pushIssue(issues, {
          code: "ANALYSIS_PATH_CYCLE",
          message: `Analysis.path creates a loading cycle through ${file}`,
          file: context.file,
          path: authoredPath(context, "analyses", id),
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
      liftMapIds(cloned as Dict);
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
      if (child.path !== undefined) {
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
      visitUniverseNode(universe.data, universe.file, "");
    }
  }
}

async function validateLoadedStructures(
  root: LoadedAnalysis,
  issues: ValidationIssue[],
  schema?: JsonSchema,
): Promise<void> {
  for (const context of walkLoaded(root)) {
    if (context === context.physicalRoot) {
      for (const issue of await validateAnalysisStructure(
        context.data as unknown as Dict,
        schema ? { schema } : {},
      )) {
        pushIssue(issues, { ...issue, file: context.file });
      }
    }
    for (const universe of context.universes) {
      for (const issue of await validateUniverseStructure(
        universe.data as unknown as Dict,
        schema ? { schema } : {},
      )) {
        pushIssue(issues, { ...issue, file: universe.file });
      }
    }
  }
}

function assembledAnalysis(context: LoadedAnalysis): Analysis {
  const { path: _path, analyses, ...data } = context.data;
  if (analyses !== undefined && !asDict(analyses)) {
    return { ...data, analyses } as Analysis;
  }
  const assembledChildren: Record<string, unknown> = { ...(asDict(analyses) ?? {}) };
  for (const child of context.children) assembledChildren[child.id!] = assembledAnalysis(child);
  return {
    ...data,
    ...(context.id ? { id: context.id } : {}),
    analyses: assembledChildren as Record<string, Analysis>,
  };
}

function validateLoadedSemantics(
  root: LoadedAnalysis,
  issues: ValidationIssue[],
): void {
  for (const context of walkLoaded(root)) {
    if (context !== context.physicalRoot) continue;
    for (const error of validateAnalysisRootFields(context.data)) {
      pushIssue(issues, {
        code: error.code,
        message: error.message,
        file: context.file,
        path: error.path,
      });
    }
  }

  const contexts = walkLoaded(root).sort(
    (left, right) => right.canonicalSegments.length - left.canonicalSegments.length,
  );
  for (const error of validateAnalysisSemantics(assembledAnalysis(root))) {
    const globalPath = error.path;
    let owner = root;
    let suffix = globalPath;
    if (globalPath) {
      for (const context of contexts) {
        const prefix = context.canonicalSegments
          .flatMap((segment) => ["analyses", segment])
          .join(".");
        if (prefix && (globalPath === prefix || globalPath.startsWith(`${prefix}.`))) {
          owner = context;
          suffix = globalPath === prefix ? undefined : globalPath.slice(prefix.length + 1);
          break;
        }
      }
    }
    if (error.code === "MISSING_SUB_FIELD" && owner.pathBacked) {
      // The physical-root pass reports the same missing inputs/outputs with
      // precise local paths.
      continue;
    }
    const localPrefix = owner.authoredSegments
      .flatMap((segment) => ["analyses", segment])
      .join(".");
    const localPath = [localPrefix, suffix].filter(Boolean).join(".") || undefined;
    pushIssue(issues, {
      code: error.code,
      message: error.message,
      file: owner.file,
      path: localPath,
    });
  }
}

function universeChild(data: Universe | UniverseNode, id: string): UniverseNode {
  return data.analyses?.[id] ?? {};
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
    for (const id of Object.keys(declaredChildren)) {
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
          throw new ResolveAnalysisError(
            "UNSUPPORTED_INLINE_UNIVERSE_REFERENCE",
            `Inline analysis '${analysisPath(child)}' cannot select a named universe`,
            file,
          );
        }
        if (childSelection.decisions !== undefined || childSelection.analyses !== undefined) {
          pushIssue(issues, {
            code: "UNIVERSE_REFERENCE_CONFLICT",
            message: "universe is mutually exclusive with inline decisions and analyses",
            file,
            path: childPath,
          });
        }
        const named = child.universeById.get(childSelection.universe);
        if (!named) {
          throw new ResolveAnalysisError(
            "UNIVERSE_NOT_FOUND",
            `Universe '${childSelection.universe}' was not found beside ${child.file}`,
            normalizedJoin(child.directory, "universes", `${childSelection.universe}.yaml`),
          );
        }
        visit(child, named.data, named.file, "", "universe", named.id);
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
  const decisions: Record<string, Decision> = {};
  for (const [id, raw] of Object.entries(asDict(context.data.decisions) ?? {})) {
    const decision = asDict(raw);
    if (decision) decisions[id] = decision as unknown as Decision;
  }
  return decisions;
}

function decisionOptions(decision: Decision): Record<string, Option> {
  return getDecisionOptions(decision as unknown as Dict) as unknown as Record<string, Option>;
}

function localInsights(
  context: LoadedAnalysis,
  collection: "prior_insights" | "findings",
): Record<string, Insight> {
  return asDict(context.data[collection]) as unknown as Record<string, Insight> ?? {};
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

class ProjectResolver {
  private readonly inputAliases = new Map<Input, AliasTarget<Input | Output>>();
  private readonly outputAliases = new Map<Output, AliasResolution<Output>>();
  private readonly decisionAliases = new Map<Decision, AliasResolution<Decision>>();
  private readonly selectedMemo = new Map<Decision, string | undefined>();
  private readonly decisionActiveMemo = new Map<Decision, boolean>();
  private readonly outputActiveMemo = new Map<Output, boolean>();

  constructor(
    private readonly root: LoadedAnalysis,
    private readonly plan: SelectionPlan,
    private readonly issues: ValidationIssue[],
  ) {}

  validate(): void {
    for (const context of this.plan.states.keys()) {
      this.validateDuplicateIds(context);
      for (const input of localInputs(context)) if (input.from) this.resolveInputAlias(context, input);
      for (const output of localOutputs(context)) {
        if (output.from) this.resolveOutputAlias(context, output);
        else this.resolveOutputProvenance(context, output);
      }
      for (const decision of Object.values(localDecisions(context))) {
        if (decision.from) this.resolveDecisionAlias(context, decision);
      }
      this.validateSelection(context);
      this.validateInsights(context);
    }
    this.validateArtifactPaths();
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
    chain = new Set<Input | Output>(),
  ): AliasTarget<Input | Output> | undefined {
    const cached = this.inputAliases.get(input);
    if (cached) return cached;
    if (chain.has(input)) {
      this.error(context, "ALIAS_CYCLE", `Alias cycle at input '${input.id}'`);
      return undefined;
    }
    chain.add(input);
    const parsed = parseUpwardReference(input.from ?? "");
    let owner: LoadedAnalysis | undefined = context;
    if (parsed) for (let count = 0; count < parsed.up; count += 1) owner = owner?.parent;
    if (!parsed || !owner) {
      this.error(context, "INVALID_FROM", `Invalid input alias '${input.from}'`);
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
    if (target && targetContext === context && !localInputs(context).includes(target as Input)) {
      this.error(context, "INVALID_FROM", `Input alias '${input.from}' cannot reference its own analysis output`);
      return undefined;
    }
    if (!target || !targetContext) {
      this.error(context, "INVALID_FROM", `Input alias target '${input.from}' does not exist`);
      return undefined;
    }
    const targetIsInput = localInputs(targetContext).includes(target as Input);
    const resolved = targetIsInput && (target as Input).from
      ? this.resolveInputAlias(targetContext, target as Input, chain)
      : !targetIsInput && (target as Output).from
        ? this.resolveOutputAlias(targetContext, target as Output, chain)
        : {
            context: targetContext,
            value: target,
            canonicalPath: recordPath(
              targetContext,
              localInputs(targetContext).includes(target as Input) ? "inputs" : "outputs",
              target.id,
            ),
          };
    if (resolved) this.inputAliases.set(input, resolved);
    return resolved;
  }

  private resolveOutputAlias(
    context: LoadedAnalysis,
    output: Output,
    chain = new Set<Input | Output>(),
  ): AliasResolution<Output> | undefined {
    const cached = this.outputAliases.get(output);
    if (cached) return cached;
    if (chain.has(output)) {
      this.error(context, "ALIAS_CYCLE", `Alias cycle at output '${output.id}'`);
      return undefined;
    }
    chain.add(output);
    const reference = output.from ?? "";
    const parts = reference.split(".");
    if (reference.startsWith("../") || parts.length < 2 || parts.some((part) => !ID_PATTERN.test(part))) {
      this.error(context, "INVALID_OUTPUT_FROM", `Invalid output alias '${reference}'`);
      return undefined;
    }
    const targetContext = this.descend(context, parts.slice(0, -1));
    const target = targetContext
      ? findById(localOutputs(targetContext), parts.at(-1)!)
      : undefined;
    if (!target || !targetContext) {
      this.error(context, "INVALID_OUTPUT_FROM", `Output alias target '${reference}' does not exist`);
      return undefined;
    }
    const immediate = {
      context: targetContext,
      value: target,
      canonicalPath: recordPath(targetContext, "outputs", target.id),
    };
    const ultimate = target.from
      ? this.resolveOutputAlias(targetContext, target, chain)
      : immediate;
    const resolved = ultimate
      ? {
          context: ultimate.context,
          value: ultimate.value,
          canonicalPath: ultimate.canonicalPath,
          immediate,
        }
      : undefined;
    if (resolved) this.outputAliases.set(output, resolved);
    return resolved;
  }

  private resolveDecisionAlias(
    context: LoadedAnalysis,
    decision: Decision,
    chain = new Set<Decision>(),
  ): AliasResolution<Decision> | undefined {
    const cached = this.decisionAliases.get(decision);
    if (cached) return cached;
    if (chain.has(decision)) {
      this.error(context, "ALIAS_CYCLE", `Alias cycle at decision '${decision.id}'`);
      return undefined;
    }
    chain.add(decision);
    const parsed = parseUpwardReference(decision.from ?? "");
    let owner: LoadedAnalysis | undefined = context;
    if (parsed) for (let count = 0; count < parsed.up; count += 1) owner = owner?.parent;
    const targetId = parsed?.rest.length === 1 ? parsed.rest[0] : undefined;
    const target = owner && targetId ? localDecisions(owner)[targetId] : undefined;
    if (!parsed || !owner || !target) {
      this.error(context, "INVALID_DECISION_FROM", `Decision alias target '${decision.from}' does not exist`);
      return undefined;
    }
    const immediate = {
      context: owner,
      value: target,
      canonicalPath: recordPath(owner, "decisions", targetId!),
    };
    const ultimate = target.from
      ? this.resolveDecisionAlias(owner, target, chain)
      : immediate;
    const resolved = ultimate
      ? {
          context: ultimate.context,
          value: ultimate.value,
          canonicalPath: ultimate.canonicalPath,
          immediate,
        }
      : undefined;
    if (resolved) this.decisionAliases.set(decision, resolved);
    return resolved;
  }

  private selectedOption(context: LoadedAnalysis, decision: Decision): string | undefined {
    if (this.selectedMemo.has(decision)) return this.selectedMemo.get(decision);
    let selected: string | undefined;
    if (decision.from) {
      const target = this.resolveDecisionAlias(context, decision);
      selected = target ? this.selectedOption(target.context, target.value) : undefined;
    } else {
      const state = this.plan.states.get(context);
      selected = state?.mode === "defaults"
        ? decision.default
        : state && getDecisionSelections(state.data as unknown as Dict)[decision.id!];
    }
    this.selectedMemo.set(decision, selected);
    return selected;
  }

  private conditionMet(
    context: LoadedAnalysis,
    when: string[] | undefined,
    path?: string,
  ): boolean {
    if (!when) return true;
    let active = true;
    for (const condition of when) {
      const negated = condition.startsWith("~");
      const reference = negated ? condition.slice(1) : condition;
      const parts = reference.split(".");
      const decision = parts.length === 2 ? localDecisions(context)[parts[0]!] : undefined;
      const effective = decision?.from
        ? this.resolveDecisionAlias(context, decision)?.value
        : decision;
      if (!decision || !effective || !decisionOptions(effective)[parts[1]!]) {
        this.error(context, "INVALID_CONDITION", `Condition '${condition}' does not resolve`, path);
        active = false;
        continue;
      }
      const matches = this.selectedOption(context, decision) === parts[1];
      if (negated ? matches : !matches) active = false;
    }
    return active;
  }

  private decisionActive(context: LoadedAnalysis, decision: Decision): boolean {
    const cached = this.decisionActiveMemo.get(decision);
    if (cached !== undefined) return cached;
    const own = this.conditionMet(
      context,
      decision.when,
      authoredPath(context, "decisions", decision.id),
    );
    const target = decision.from
      ? this.resolveDecisionAlias(context, decision)?.immediate
      : undefined;
    const active = own && (!target || this.decisionActive(target.context, target.value));
    this.decisionActiveMemo.set(decision, active);
    return active;
  }

  private outputActive(context: LoadedAnalysis, output: Output): boolean {
    const cached = this.outputActiveMemo.get(output);
    if (cached !== undefined) return cached;
    const own = this.conditionMet(
      context,
      output.when,
      authoredPath(context, "outputs", output.id),
    );
    const target = output.from
      ? this.resolveOutputAlias(context, output)?.immediate
      : undefined;
    const active = own && (!target || this.outputActive(target.context, target.value));
    this.outputActiveMemo.set(output, active);
    return active;
  }

  private validateSelection(context: LoadedAnalysis): void {
    const state = this.plan.states.get(context)!;
    const selections = getDecisionSelections(state.data as unknown as Dict);
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
      }
      if (!selected) {
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
        continue;
      }
      const option = decisionOptions(decision)[selected];
      if (!option) {
        this.error(
          context,
          "UNKNOWN_OPTION",
          `Decision '${id}' has no option '${selected}'`,
          decisionSelectionPath,
          state.file,
        );
        continue;
      }
      if (option.excluded) {
        this.error(
          context,
          "EXCLUDED_OPTION_SELECTED",
          `Option '${id}.${selected}' is excluded`,
          decisionSelectionPath,
          state.file,
        );
      }
    }
    const effectiveSelections: Record<string, string> = {};
    for (const [id, decision] of Object.entries(decisions)) {
      const selected = this.selectedOption(context, decision);
      if (selected) effectiveSelections[id] = selected;
    }
    for (const [id, decision] of Object.entries(decisions)) {
      if (decision.from) continue;
      const selected = effectiveSelections[id];
      if (!selected) continue;
      const option = decisionOptions(decision)[selected];
      for (const reference of option?.incompatible_with ?? []) {
        const [otherDecision, otherOption, extra] = reference.split(".");
        if (extra !== undefined || !otherDecision || !otherOption) continue;
        if (effectiveSelections[otherDecision] === otherOption) {
          this.error(
            context,
            "INCOMPATIBLE_OPTIONS",
            `Option '${id}.${selected}' is incompatible with '${reference}'`,
            selectionPath(id),
            state.file,
          );
        }
      }
      for (const reference of option?.requires ?? []) {
        const [otherDecision, otherOption, extra] = reference.split(".");
        if (extra !== undefined || !otherDecision || !otherOption) continue;
        if (effectiveSelections[otherDecision] !== otherOption) {
          this.error(
            context,
            "MISSING_REQUIRED_OPTION",
            `Option '${id}.${selected}' requires '${reference}'`,
            selectionPath(id),
            state.file,
          );
        }
      }
    }
  }

  private resolveOutputProvenance(
    context: LoadedAnalysis,
    output: Output,
  ): { inputPaths: string[]; decisionPaths: string[] } {
    const inputPaths: string[] = [];
    for (const id of output.inputs ?? []) {
      const input = findById(localInputs(context), id);
      const siblingOutput = findById(localOutputs(context), id);
      if (input) {
        const target = input.from ? this.resolveInputAlias(context, input) : undefined;
        inputPaths.push(target?.canonicalPath ?? recordPath(context, "inputs", id));
      } else if (siblingOutput) {
        const target = siblingOutput.from ? this.resolveOutputAlias(context, siblingOutput) : undefined;
        inputPaths.push(target?.canonicalPath ?? recordPath(context, "outputs", id));
      } else {
        this.error(
          context,
          "UNKNOWN_OUTPUT_INPUT",
          `Output '${output.id}' references unknown input '${id}'`,
          authoredPath(context, "outputs", output.id),
        );
      }
    }
    const decisionPaths: string[] = [];
    for (const id of output.decisions ?? []) {
      const decision = localDecisions(context)[id];
      if (!decision) {
        this.error(
          context,
          "UNKNOWN_OUTPUT_DECISION",
          `Output '${output.id}' references unknown decision '${id}'`,
          authoredPath(context, "outputs", output.id),
        );
      } else {
        const target = decision.from ? this.resolveDecisionAlias(context, decision) : undefined;
        decisionPaths.push(target?.canonicalPath ?? recordPath(context, "decisions", id));
      }
    }
    return { inputPaths, decisionPaths };
  }

  private validateInsights(context: LoadedAnalysis): void {
    for (const decision of Object.values(localDecisions(context))) {
      const target = decision.from ? this.resolveDecisionAlias(context, decision) : undefined;
      if (target) continue;
      for (const [optionId, option] of Object.entries(decisionOptions(decision))) {
        for (const insightId of option.insights ?? []) {
          if (!localInsights(context, "prior_insights")[insightId]) {
            this.error(
              context,
              "INVALID_INSIGHT_REF",
              `Option '${optionId}' references unknown prior insight '${insightId}'`,
            );
          }
        }
      }
    }
    for (const collection of ["prior_insights", "findings"] as const) {
      for (const [id, insight] of Object.entries(localInsights(context, collection))) {
        insight.evidence.forEach((evidence, index) => {
          if (evidence.artifact && !findById(localOutputs(context), evidence.artifact)) {
            this.error(
              context,
              "INVALID_ARTIFACT_REF",
              `Evidence references unknown output '${evidence.artifact}'`,
              `${authoredPath(context, collection, id)}.evidence.${index}.artifact`,
            );
          }
        });
      }
    }
  }

  private validateArtifactPaths(): void {
    const seen = new Map<string, string>();
    for (const context of this.plan.states.keys()) {
      const universeId = this.plan.states.get(context)!.effectiveUniverseId;
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

  project(): ResolvedAnalysisNode {
    return this.projectAnalysis(this.root);
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
        this.projectInsight(context, "prior_insight", { ...insight, id })),
      findings: Object.entries(localInsights(context, "findings")).map(([id, insight]) =>
        this.projectInsight(context, "finding", { ...insight, id })),
      analyses: context.children.map((child) => this.projectAnalysis(child) as ResolvedAnalysisNode & { id: string }),
    };
  }

  private projectInput(context: LoadedAnalysis, input: Input): ResolvedInput {
    const target = input.from ? this.resolveInputAlias(context, input)! : undefined;
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
    const target = output.from ? this.resolveOutputAlias(context, output)! : undefined;
    const source = target?.value ?? output;
    const sourceContext = target?.context ?? context;
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
      provenance: this.resolveOutputProvenance(sourceContext, source),
    };
    return projected;
  }

  private projectDecision(
    context: LoadedAnalysis,
    id: string,
    decision: Decision,
  ): ResolvedDecision {
    const target = decision.from ? this.resolveDecisionAlias(context, decision)! : undefined;
    const source = target?.value ?? decision;
    const sourceContext = target?.context ?? context;
    const {
      id: _sourceId,
      from: _sourceFrom,
      when: _sourceWhen,
      options: _sourceOptions,
      ...sourceContent
    } = source;
    const options = Object.entries(decisionOptions(source)).map(([id, option]) =>
      this.projectOption(sourceContext, id, option));
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
    context: LoadedAnalysis,
    id: string,
    option: Option,
  ): ResolvedOption {
    return {
      ...option,
      id,
      resolvedInsightPaths: (option.insights ?? []).map((insightId) =>
        recordPath(context, "prior_insights", insightId)),
    };
  }

  private projectInsight(
    context: LoadedAnalysis,
    kind: "finding" | "prior_insight",
    insight: Insight,
  ): ResolvedInsight {
    const collection = kind === "finding" ? "findings" : "prior_insights";
    return {
      ...insight,
      canonicalPath: recordPath(context, collection, insight.id),
      kind,
      evidence: insight.evidence.map((evidence): ResolvedEvidence => ({
        ...evidence,
        ...(evidence.artifact
          ? { resolvedOutputPath: recordPath(context, "outputs", evidence.artifact) }
          : {}),
      })),
    };
  }

  artifactPath(context: LoadedAnalysis, output: Output): string | undefined {
    const target = output.from ? this.resolveOutputAlias(context, output) : undefined;
    const source = target?.value ?? output;
    const owner = target?.context ?? context;
    if (!source.format) return undefined;
    const state = this.plan.states.get(owner);
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
  const encoder = new TextEncoder();
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${path}\0${modifiedAtMs}\0${byteSize}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
  resolver: ProjectResolver,
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

/** Load, validate, and resolve one ASTRA project through a host adapter. */
export async function resolveAnalysis(
  reader: ProjectReader,
  options: ResolveOptions = {},
): Promise<ResolvedAnalysisBundle> {
  const issues: ValidationIssue[] = [];
  const root = await loadAnalysisFile(reader, "astra.yaml", issues, {
    canonicalSegments: [],
    authoredSegments: [],
    artifactPrefix: [],
    pathBacked: false,
    ancestry: new Set<string>(),
  });
  validateMapAgreements(root, issues);
  await validateLoadedStructures(root, issues, options.schema);
  try {
    validateLoadedSemantics(root, issues);
  } catch (error) {
    // Semantic validation expects structurally valid input. Preserve all
    // structural issues when malformed values make that pass inapplicable.
    if (!issues.length) throw error;
  }
  if (issues.length) throw new AnalysisValidationError(issues);

  let selected: LoadedUniverse | undefined;
  let source: "explicit" | "implicit" | "none";
  if (options.universeId !== undefined) {
    selected = root.universeById.get(options.universeId);
    if (!selected) {
      throw new ResolveAnalysisError(
        "UNIVERSE_NOT_FOUND",
        `Root universe '${options.universeId}' does not exist`,
        normalizedJoin("universes", `${options.universeId}.yaml`),
      );
    }
    source = "explicit";
  } else {
    selected = root.universes[0];
    source = selected ? "implicit" : "none";
  }

  // Validate every authored universe, not just the selected configuration.
  let selectedResolver: ProjectResolver | undefined;
  for (const context of walkLoaded(root)) {
    for (const universe of context.universes) {
      const plan = buildSelectionPlan(context, universe.data, universe.file, universe.id, issues);
      const resolver = new ProjectResolver(context, plan, issues);
      resolver.validate();
      if (universe === selected) selectedResolver = resolver;
    }
  }
  if (!selectedResolver) {
    const plan = buildSelectionPlan(root, undefined, "astra.yaml", "default", issues);
    selectedResolver = new ProjectResolver(root, plan, issues);
    selectedResolver.validate();
  }
  if (issues.length) throw new AnalysisValidationError(issues);

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
