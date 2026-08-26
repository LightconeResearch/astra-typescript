import {
  type Dict,
  asArray,
  asDict,
  collectNodeDecisions,
  getDecisionOptions,
  getDecisionSelections,
  getInputIds,
  getOutputIds,
  isConditionMet,
} from "../helpers.js";
import type { Analysis } from "../types.js";

export class SemanticError {
  constructor(
    public readonly code: string,
    public readonly message: string,
    public readonly path?: string,
  ) {}

  toString(): string {
    return this.path ? `[${this.code}] ${this.path}: ${this.message}` : `[${this.code}] ${this.message}`;
  }
}

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Validate fields required of every physical astra.yaml root. */
export function validateAnalysisRootFields(
  data: Analysis | Dict,
): SemanticError[] {
  const working = data as Dict;
  const errors: SemanticError[] = [];
  for (const field of ["version", "name", "inputs", "outputs"]) {
    if (working[field] == null) {
      errors.push(
        new SemanticError(
          "MISSING_ROOT_FIELD",
          `Root analysis is missing required field '${field}'`,
          field,
        ),
      );
    }
  }
  return errors;
}

/** Parse a `../scope.id` style path. Returns null on malformed input. */
function parseFromPath(ref: string): { up: number; segments: string[] } | null {
  let up = 0;
  let rest = ref;
  while (rest.startsWith("../")) {
    up += 1;
    rest = rest.slice(3);
  }
  if (!rest || rest.startsWith(".") || rest.endsWith(".")) return null;
  const segments = rest.split(".");
  for (const seg of segments) if (!ID_PATTERN.test(seg)) return null;
  return { up, segments };
}

function checkPathExclusivity(data: Dict, errors: SemanticError[], pathPrefix = ""): void {
  const subAnalyses = asDict(data.analyses) ?? {};
  for (const [subId, raw] of Object.entries(subAnalyses)) {
    const sub = asDict(raw);
    if (!sub) continue;
    const fullPath = pathPrefix ? `${pathPrefix}.analyses.${subId}` : `analyses.${subId}`;
    if (sub.path) {
      const extra = Object.keys(sub).filter((k) => k !== "path").sort();
      if (extra.length) {
        errors.push(
          new SemanticError(
            "PATH_FIELD_CONFLICT",
            `Sub-analysis '${subId}' has 'path:' alongside fields ${JSON.stringify(extra)}; ` +
              `content must come from the referenced file. Move these fields into the sub's astra.yaml.`,
            fullPath,
          ),
        );
      }
    } else {
      checkPathExclusivity(sub, errors, fullPath);
    }
  }
}

/** Validate an Analysis dict semantically. Returns the list of errors. */
export function validateAnalysis(
  data: Analysis | Dict,
): SemanticError[] {
  const errors: SemanticError[] = [];
  const working = data as Dict;

  // Run before any external `path:` resolution merges over content fields.
  checkPathExclusivity(working, errors);

  errors.push(...validateAnalysisRootFields(working));

  const inputs = asArray<Dict>(working.inputs);
  const outputs = asArray<Dict>(working.outputs);
  const priorInsights = asDict(working.prior_insights) ?? {};

  const inputIds = new Set<string>();
  for (const inp of inputs) {
    const id = inp?.id as string | undefined;
    if (id && inputIds.has(id)) {
      errors.push(new SemanticError("DUPLICATE_INPUT", `Duplicate input ID: ${id}`, `inputs.${id}`));
    }
    if (id) inputIds.add(id);
  }

  const outputIds = new Set<string>();
  for (const out of outputs) {
    const id = out?.id as string | undefined;
    if (id && outputIds.has(id)) {
      errors.push(new SemanticError("DUPLICATE_OUTPUT", `Duplicate output ID: ${id}`, `outputs.${id}`));
    }
    if (id) outputIds.add(id);
  }

  const rootDecisions = collectNodeDecisions(working) as unknown as Record<string, Dict>;
  errors.push(..._validateDecisions(asDict(working.decisions) ?? {}, priorInsights as Dict, ""));

  errors.push(
    ..._validateInsightArtifacts(asDict(working.prior_insights) ?? {}, outputIds, "", "prior_insights"),
  );
  errors.push(
    ..._validateInsightArtifacts(asDict(working.findings) ?? {}, outputIds, "", "findings"),
  );

  const subAnalyses = asDict(working.analyses) ?? {};
  const subOutputIds = new Set<string>();
  for (const [analysisId, raw] of Object.entries(subAnalyses)) {
    const sub = asDict(raw);
    if (!sub) continue;
    for (const out of asArray<Dict>(sub.outputs)) {
      const oid = out?.id as string | undefined;
      if (oid) subOutputIds.add(`${analysisId}.${oid}`);
    }
  }

  errors.push(..._validateOutputsFrom(outputs, working, ""));

  errors.push(
    ..._validateOutputDependencies(outputs, {
      analysisInputIds: inputIds,
      decisionsInScope: rootDecisions,
      pathPrefix: "",
      extraValidIds: subOutputIds,
    }),
  );

  errors.push(..._validateOutputWhen(outputs, rootDecisions, ""));

  for (const [analysisId, raw] of Object.entries(subAnalyses)) {
    const sub = asDict(raw);
    if (!sub) continue;
    errors.push(
      ..._validateAnalysisNode(analysisId, sub, [working], "analyses"),
    );
  }

  return errors;
}

function _validateAnalysisNode(
  nodeId: string,
  node: Dict,
  ancestorChain: Dict[],
  pathPrefix: string,
): SemanticError[] {
  const errors: SemanticError[] = [];
  const nodePath = `${pathPrefix}.${nodeId}`;

  if (node.path && !node.inputs && !node.outputs) return errors;

  for (const field of ["inputs", "outputs"]) {
    if (!node[field]) {
      errors.push(
        new SemanticError(
          "MISSING_SUB_FIELD",
          `Sub-analysis '${nodeId}' is missing required field: ${field}`,
          nodePath,
        ),
      );
    }
  }

  const allDecisions = (asDict(node.decisions) ?? {}) as Record<string, Dict>;
  for (const [decisionId, decision] of Object.entries(allDecisions)) {
    const ref = decision?.from as string | undefined;
    if (ref) {
      errors.push(
        ..._validateDecisionFrom(ref, ancestorChain, `${nodePath}.decisions.${decisionId}`),
      );
    }
  }

  const nodeInputs = asArray<Dict>(node.inputs);
  const nodeInputIds = new Set<string>();
  for (const inp of nodeInputs) {
    const id = inp?.id as string | undefined;
    if (id) nodeInputIds.add(id);
    const ref = inp?.from as string | undefined;
    if (ref) errors.push(..._validateInputFrom(ref, ancestorChain, nodeId, nodePath));
  }

  const nodeOutputIds = new Set<string>();
  for (const out of asArray<Dict>(node.outputs)) {
    const id = out?.id as string | undefined;
    if (id && nodeOutputIds.has(id)) {
      errors.push(
        new SemanticError(
          "DUPLICATE_OUTPUT",
          `Duplicate output ID in analysis node: ${id}`,
          `${nodePath}.outputs.${id}`,
        ),
      );
    }
    if (id) nodeOutputIds.add(id);
  }

  const nodeOutputs = asArray<Dict>(node.outputs);
  errors.push(..._validateOutputsFrom(nodeOutputs, node, nodePath));

  const nodeDecisions = collectNodeDecisions(node) as Record<string, Dict>;
  const priorInsights = asDict(node.prior_insights) ?? {};

  // Build the constraint scope: locally-defined decisions plus any `from:`
  // alias resolved through its full ancestor chain.
  const constraintScope: Record<string, Dict> = { ...nodeDecisions };
  const scopeChain = [...ancestorChain, node];
  for (const [decisionId, rawDecision] of Object.entries(allDecisions)) {
    const decision = asDict(rawDecision);
    if (!decision?.from) continue;
    const target = _resolveDecisionDefinition(
      decision,
      scopeChain,
      scopeChain.length - 1,
    );
    if (target) constraintScope[decisionId] = target;
  }

  errors.push(
    ..._validateDecisions(asDict(node.decisions) ?? {}, priorInsights, nodePath, constraintScope),
  );

  errors.push(
    ..._validateInsightArtifacts(
      asDict(node.prior_insights) ?? {},
      nodeOutputIds,
      nodePath,
      "prior_insights",
    ),
  );
  errors.push(
    ..._validateInsightArtifacts(asDict(node.findings) ?? {}, nodeOutputIds, nodePath, "findings"),
  );

  const subAnalyses = asDict(node.analyses) ?? {};
  const subOutputIds = new Set<string>();
  for (const [subId, raw] of Object.entries(subAnalyses)) {
    const sub = asDict(raw);
    if (!sub) continue;
    for (const out of asArray<Dict>(sub.outputs)) {
      const oid = out?.id as string | undefined;
      if (oid) subOutputIds.add(`${subId}.${oid}`);
    }
  }

  errors.push(
    ..._validateOutputDependencies(nodeOutputs, {
      analysisInputIds: nodeInputIds,
      decisionsInScope: constraintScope,
      pathPrefix: nodePath,
      extraValidIds: subOutputIds,
    }),
  );
  errors.push(..._validateOutputWhen(nodeOutputs, constraintScope, nodePath));

  for (const [subId, raw] of Object.entries(subAnalyses)) {
    const sub = asDict(raw);
    if (!sub) continue;
    errors.push(
      ..._validateAnalysisNode(
        subId,
        sub,
        [...ancestorChain, node],
        `${nodePath}.analyses`,
      ),
    );
  }

  return errors;
}

function _validateOutputsFrom(
  outputs: Dict[],
  currentScope: Dict,
  pathPrefix: string,
): SemanticError[] {
  const errors: SemanticError[] = [];
  const prefix = pathPrefix ? `${pathPrefix}.outputs` : "outputs";
  for (const out of outputs) {
    const ref = out?.from as string | undefined;
    const id = out?.id as string | undefined;
    if (!ref || !id) continue;
    errors.push(..._validateOutputFrom(ref, currentScope, `${prefix}.${id}`));
  }
  return errors;
}

function _validateInsightArtifacts(
  insights: Dict,
  outputIds: Set<string>,
  pathPrefix: string,
  section: string,
): SemanticError[] {
  const errors: SemanticError[] = [];
  if (!insights || Object.keys(insights).length === 0) return errors;
  const prefix = pathPrefix ? `${pathPrefix}.${section}` : section;
  for (const [insightId, raw] of Object.entries(insights)) {
    const insight = asDict(raw);
    if (!insight) continue;
    const insightPath = `${prefix}.${insightId}`;
    const evidenceList = asArray<Dict>(insight.evidence);
    evidenceList.forEach((ev, i) => {
      const artifactRef = ev?.artifact as string | undefined;
      if (artifactRef !== undefined && !outputIds.has(artifactRef)) {
        errors.push(
          new SemanticError(
            "INVALID_ARTIFACT_REF",
            `Evidence artifact '${artifactRef}' not found in declared outputs`,
            `${insightPath}.evidence[${i}].artifact`,
          ),
        );
      }
    });
  }
  return errors;
}

function _validateDecisions(
  decisions: Record<string, unknown>,
  priorInsights: Dict,
  pathPrefix: string,
  constraintScope?: Record<string, Dict>,
): SemanticError[] {
  const errors: SemanticError[] = [];
  const localScope: Record<string, Dict> = {};
  for (const [id, raw] of Object.entries(decisions)) {
    const decision = asDict(raw);
    if (decision && !decision.from) localScope[id] = decision;
  }
  const scope = constraintScope ?? localScope;
  const decisionsPrefix = pathPrefix ? `${pathPrefix}.decisions` : "decisions";

  for (const [decisionId, rawDecision] of Object.entries(decisions)) {
    const decisionPath = `${decisionsPrefix}.${decisionId}`;
    const decision = asDict(rawDecision);
    if (!decision) {
      errors.push(
        new SemanticError(
          "MISSING_DECISION_DEFINITION",
          `Decision '${decisionId}' has no definition`,
          decisionPath,
        ),
      );
      continue;
    }
    if (decision.from) continue;
    const options = getDecisionOptions(decision);

    const defaultOpt = decision.default as string | undefined;
    if (defaultOpt != null && !(defaultOpt in options)) {
      errors.push(
        new SemanticError(
          "INVALID_DEFAULT",
          `Default option '${defaultOpt}' not found in options`,
          decisionPath,
        ),
      );
    }

    errors.push(
      ..._validateWhenRefs(decision.when, {
        decisions: scope,
        path: decisionPath,
        ownerKind: "Decision",
        forbidSelfRef: decisionId,
      }),
    );

    for (const [optionId, optionRaw] of Object.entries(options)) {
      const option = optionRaw;
      const optionPath = `${decisionPath}.options.${optionId}`;

      const insightRefs = asArray<string>(option.insights);
      insightRefs.forEach((insightRef, i) => {
        if (!(insightRef in priorInsights)) {
          errors.push(
            new SemanticError(
              "INVALID_INSIGHT_REF",
              `Option insight '${insightRef}' not found in prior_insights`,
              `${optionPath}.insights[${i}]`,
            ),
          );
        }
      });

      for (const ref of asArray<string>(option.incompatible_with)) {
        errors.push(..._validateConstraintRef(ref, scope, optionPath));
      }
      for (const ref of asArray<string>(option.requires)) {
        errors.push(..._validateConstraintRef(ref, scope, optionPath));
      }

      const isExcluded = option.excluded === true;
      const excludedReason = option.excluded_reason as string | undefined;
      if (isExcluded && !excludedReason) {
        errors.push(
          new SemanticError(
            "MISSING_EXCLUDED_REASON",
            `Excluded option '${optionId}' must have an 'excluded_reason'`,
            optionPath,
          ),
        );
      }
      if (excludedReason && !isExcluded) {
        errors.push(
          new SemanticError(
            "ORPHAN_EXCLUDED_REASON",
            `Option '${optionId}' has 'excluded_reason' but is not marked excluded`,
            optionPath,
          ),
        );
      }
    }

    if (defaultOpt != null && defaultOpt in options) {
      const defaultOption = options[defaultOpt]!;
      if (defaultOption.excluded === true) {
        errors.push(
          new SemanticError(
            "EXCLUDED_DEFAULT",
            `Default option '${defaultOpt}' is marked as excluded`,
            decisionPath,
          ),
        );
      }
    }
  }

  return errors;
}

function _validateOutputWhen(
  outputs: Dict[],
  decisions: Record<string, Dict>,
  pathPrefix: string,
): SemanticError[] {
  const errors: SemanticError[] = [];
  const outputsPrefix = pathPrefix ? `${pathPrefix}.outputs` : "outputs";
  for (const out of outputs) {
    const id = out?.id as string | undefined;
    if (!id) continue;
    errors.push(
      ..._validateWhenRefs(out.when, {
        decisions,
        path: `${outputsPrefix}.${id}`,
        ownerKind: "Output",
      }),
    );
  }
  return errors;
}

interface WhenRefContext {
  decisions: Record<string, Dict>;
  path: string;
  ownerKind: "Decision" | "Output";
  /** Decision ID that may not appear in its own `when` clause. */
  forbidSelfRef?: string;
}

function _validateWhenRefs(
  when: unknown,
  ctx: WhenRefContext,
): SemanticError[] {
  if (when == null) return [];
  const conds = typeof when === "string" ? [when] : Array.isArray(when) ? (when as string[]) : [];
  const errors: SemanticError[] = [];
  for (const cond of conds) {
    const ref = cond.startsWith("~") ? cond.slice(1) : cond;
    const parts = ref.split(".");
    if (parts.length !== 2) {
      errors.push(
        new SemanticError(
          "INVALID_WHEN_REF",
          `${ctx.ownerKind} 'when' condition '${cond}' has invalid format`,
          ctx.path,
        ),
      );
      continue;
    }
    const [decisionId, optionId] = parts as [string, string];
    const referenced = ctx.decisions[decisionId];
    if (!referenced) {
      const subject = ctx.ownerKind === "Output" ? `${ctx.ownerKind} 'when'` : "'when'";
      errors.push(
        new SemanticError(
          "INVALID_WHEN_REF",
          `${subject} references non-existent decision '${decisionId}'`,
          ctx.path,
        ),
      );
    } else {
      const refOptions = getDecisionOptions(referenced);
      if (!(optionId in refOptions)) {
        const subject = ctx.ownerKind === "Output" ? `${ctx.ownerKind} 'when'` : "'when'";
        errors.push(
          new SemanticError(
            "INVALID_WHEN_REF",
            `${subject} references non-existent option '${optionId}' in decision '${decisionId}'`,
            ctx.path,
          ),
        );
      }
    }
    if (ctx.forbidSelfRef && decisionId === ctx.forbidSelfRef) {
      errors.push(
        new SemanticError("INVALID_WHEN_REF", "'when' cannot reference own decision", ctx.path),
      );
    }
  }
  return errors;
}

interface OutputDepsArgs {
  analysisInputIds: Set<string>;
  decisionsInScope: Record<string, Dict>;
  pathPrefix: string;
  extraValidIds?: Set<string>;
}

function _validateOutputDependencies(
  outputs: Dict[],
  args: OutputDepsArgs,
): SemanticError[] {
  const errors: SemanticError[] = [];
  const { analysisInputIds, decisionsInScope, pathPrefix, extraValidIds } = args;
  const outputsPrefix = pathPrefix ? `${pathPrefix}.outputs` : "outputs";

  const outputIds = new Set<string>();
  for (const out of outputs) if (out?.id) outputIds.add(out.id as string);
  const siblingOrExtra = new Set<string>([...outputIds, ...(extraValidIds ?? new Set())]);
  const validInputIds = new Set<string>([...analysisInputIds, ...siblingOrExtra]);

  const depGraph: Record<string, string[]> = {};

  for (const out of outputs) {
    const id = out?.id as string | undefined;
    if (!id) continue;
    const outPath = `${outputsPrefix}.${id}`;

    if (out.from) {
      depGraph[id] = [];
      continue;
    }

    const declaredInputs = asArray<string>(out.inputs);
    depGraph[id] = declaredInputs.filter((i) => siblingOrExtra.has(i));

    for (const inpId of declaredInputs) {
      if (!validInputIds.has(inpId)) {
        errors.push(
          new SemanticError(
            "INVALID_OUTPUT_INPUT",
            `Output input '${inpId}' is not a declared analysis input or sibling output`,
            `${outPath}.inputs`,
          ),
        );
      }
    }

    const declaredDecisions = asArray<string>(out.decisions);
    for (const decId of declaredDecisions) {
      if (!(decId in decisionsInScope)) {
        errors.push(
          new SemanticError(
            "INVALID_OUTPUT_DECISION",
            `Output decision '${decId}' is not a decision in scope`,
            `${outPath}.decisions`,
          ),
        );
      }
    }

    const recipe = asDict(out.recipe);
    const command = recipe?.command;
    if (typeof command === "string" && command) {
      errors.push(
        ..._validateCommandTemplate(
          command,
          new Set(declaredInputs),
          new Set(declaredDecisions),
          `${outPath}.recipe.command`,
        ),
      );
    }
  }

  const cycle = _detectOutputCycle(depGraph);
  if (cycle) {
    errors.push(
      new SemanticError("OUTPUT_CYCLE", `Dependency cycle detected: ${cycle.join(" -> ")}`, outputsPrefix),
    );
  }

  return errors;
}

/** Iterate Python `string.Formatter.parse()`-style fields out of a
 *  format string. Yields `{ field, formatSpec, conversion }` for each
 *  placeholder; `{{` and `}}` are emitted as literal braces (skipped). */
function* iterTemplateFields(
  command: string,
): Generator<{ field: string | null; formatSpec: string; conversion: string | null }> {
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === "{") {
      if (command[i + 1] === "{") {
        // literal {
        i += 2;
        continue;
      }
      // find matching } (no nested braces inside placeholders for our purposes)
      const end = command.indexOf("}", i + 1);
      if (end < 0) {
        throw new Error("Single '{' encountered in format string");
      }
      const body = command.slice(i + 1, end);
      // Conversion: !s, !r, !a — single char after `!`.
      let field = body;
      let conversion: string | null = null;
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
      i = end + 1;
    } else if (ch === "}") {
      if (command[i + 1] === "}") {
        i += 2;
        continue;
      }
      throw new Error("Single '}' encountered in format string");
    } else {
      i++;
    }
  }
}

function _validateCommandTemplate(
  command: string,
  declaredInputs: Set<string>,
  declaredDecisions: Set<string>,
  path: string,
): SemanticError[] {
  const errors: SemanticError[] = [];
  let fields: { field: string | null; formatSpec: string; conversion: string | null }[];
  try {
    fields = [...iterTemplateFields(command)];
  } catch (e) {
    return [new SemanticError("INVALID_COMMAND_TEMPLATE", (e as Error).message, path)];
  }

  const declared: Record<string, Set<string>> = {
    inputs: declaredInputs,
    decisions: declaredDecisions,
  };

  for (const { field, formatSpec, conversion } of fields) {
    if (field == null) continue;
    if (field === "" || formatSpec || conversion) {
      errors.push(
        new SemanticError("INVALID_COMMAND_TEMPLATE", `Invalid command placeholder '{${field}}'`, path),
      );
      continue;
    }
    if (field === "output" || field === "inputs") continue;
    const dot = field.indexOf(".");
    if (dot >= 0) {
      const head = field.slice(0, dot);
      const tail = field.slice(dot + 1);
      if (!tail.includes(".") && head in declared) {
        if (!declared[head]!.has(tail)) {
          const singular = head === "inputs" ? "input" : "decision";
          errors.push(
            new SemanticError(
              "UNDECLARED_TEMPLATE_REF",
              `Command placeholder '{${field}}' references undeclared ${singular} '${tail}' (add it to Output.${head})`,
              path,
            ),
          );
        }
        continue;
      }
    }
    errors.push(
      new SemanticError(
        "INVALID_COMMAND_TEMPLATE",
        `Unknown command placeholder '{${field}}' (use {inputs}, {inputs.<id>}, {decisions.<id>}, or {output})`,
        path,
      ),
    );
  }

  return errors;
}

function _detectOutputCycle(depGraph: Record<string, string[]>): string[] | null {
  const White = 0;
  const Gray = 1;
  const Black = 2;
  const color: Record<string, number> = {};
  for (const id of Object.keys(depGraph)) color[id] = White;
  const path: string[] = [];

  function dfs(node: string): string[] | null {
    color[node] = Gray;
    path.push(node);
    for (const dep of depGraph[node] ?? []) {
      if (!(dep in color)) continue;
      if (color[dep] === Gray) {
        const start = path.indexOf(dep);
        return [...path.slice(start), dep];
      }
      if (color[dep] === White) {
        const result = dfs(dep);
        if (result) return result;
      }
    }
    path.pop();
    color[node] = Black;
    return null;
  }

  for (const id of Object.keys(depGraph)) {
    if (color[id] === White) {
      const result = dfs(id);
      if (result) return result;
    }
  }
  return null;
}

function _resolveAncestorScope(chain: Dict[], up: number): Dict | null {
  if (up <= 0 || up > chain.length) return null;
  return chain[chain.length - up] ?? null;
}

function _resolveDecisionDefinition(
  decision: Dict,
  scopeChain: Dict[],
  scopeIndex: number,
): Dict | undefined {
  const ref = decision.from;
  if (typeof ref !== "string") return decision;
  const parsed = parseFromPath(ref);
  if (!parsed || parsed.up <= 0 || parsed.segments.length !== 1) return undefined;
  const targetIndex = scopeIndex - parsed.up;
  if (targetIndex < 0) return undefined;
  const targetScope = scopeChain[targetIndex];
  const target = targetScope
    ? asDict(asDict(targetScope.decisions)?.[parsed.segments[0]!])
    : undefined;
  return target
    ? _resolveDecisionDefinition(target, scopeChain, targetIndex)
    : undefined;
}

function _validateDecisionFrom(
  ref: string,
  ancestorChain: Dict[],
  decisionPath: string,
): SemanticError[] {
  const mkErr = (m: string): SemanticError[] => [new SemanticError("INVALID_DECISION_FROM", m, decisionPath)];
  const parsed = parseFromPath(ref);
  if (!parsed) return mkErr(`Decision.from '${ref}' has invalid path syntax`);
  if (parsed.up === 0)
    return mkErr(`Decision.from '${ref}' must start with '../' to reference an ancestor decision`);
  if (parsed.segments.length !== 1)
    return mkErr(
      `Decision.from '${ref}' must reference a single decision id ` +
        `(no descent into sibling/child scopes allowed; lift the decision to a common ancestor instead)`,
    );
  const target = _resolveAncestorScope(ancestorChain, parsed.up);
  if (!target)
    return mkErr(
      `Decision.from '${ref}' escapes ${parsed.up} level(s) but only ${ancestorChain.length} ancestor scope(s) available`,
    );
  const targetDecisions = (asDict(target.decisions) ?? {}) as Record<string, Dict>;
  if (!(parsed.segments[0]! in targetDecisions))
    return mkErr(`Decision.from '${ref}' points to non-existent ancestor decision '${parsed.segments[0]}'`);
  return [];
}

function _validateInputFrom(
  ref: string,
  ancestorChain: Dict[],
  currentNodeId: string,
  nodePath: string,
): SemanticError[] {
  const mkErr = (m: string): SemanticError[] => [new SemanticError("INVALID_FROM", m, nodePath)];
  const parsed = parseFromPath(ref);
  if (!parsed) return mkErr(`Input.from '${ref}' has invalid path syntax`);
  if (parsed.up === 0)
    return mkErr(
      `Input.from '${ref}' must start with '../' to escape upward ` +
        `(downward references aren't allowed on Inputs; consume sub outputs via Output re-export)`,
    );
  const target = _resolveAncestorScope(ancestorChain, parsed.up);
  if (!target)
    return mkErr(
      `Input.from '${ref}' escapes ${parsed.up} level(s) but only ${ancestorChain.length} ancestor scope(s) available`,
    );

  if (parsed.segments.length === 1) {
    if (!getInputIds(target).has(parsed.segments[0]!))
      return mkErr(`Input.from '${ref}' points to non-existent ancestor input '${parsed.segments[0]}'`);
    return [];
  }

  let current: Dict = target;
  const heads = parsed.segments.slice(0, -1);
  for (let i = 0; i < heads.length; i++) {
    const seg = heads[i]!;
    const subAnalyses = asDict(current.analyses) ?? {};
    if (!(seg in subAnalyses))
      return mkErr(
        `Input.from '${ref}': sub-analysis '${seg}' not found at depth ${i} in target scope`,
      );
    if (parsed.up === 1 && i === 0 && seg === currentNodeId)
      return mkErr(`Input.from '${ref}' cannot reference own outputs`);
    current = subAnalyses[seg] as Dict;
  }
  const tail = parsed.segments[parsed.segments.length - 1]!;
  if (!getOutputIds(current).has(tail))
    return mkErr(`Input.from '${ref}': output '${tail}' not found in target sub-analysis`);
  return [];
}

function _validateOutputFrom(
  ref: string,
  currentScope: Dict,
  outputPath: string,
): SemanticError[] {
  const mkErr = (m: string): SemanticError[] => [
    new SemanticError("INVALID_OUTPUT_FROM", m, outputPath),
  ];
  const parsed = parseFromPath(ref);
  if (!parsed) return mkErr(`Output.from '${ref}' has invalid path syntax`);
  if (parsed.up !== 0)
    return mkErr(
      `Output.from '${ref}' must descend into a sub-analysis ` +
        `(upward references aren't allowed; outputs flow up via per-layer re-export)`,
    );
  if (parsed.segments.length < 2)
    return mkErr(
      `Output.from '${ref}' must take the form 'child.out_id' ` +
        `(at least one descent step into a named sub-analysis)`,
    );

  let current: Dict = currentScope;
  const heads = parsed.segments.slice(0, -1);
  for (let i = 0; i < heads.length; i++) {
    const seg = heads[i]!;
    const subAnalyses = asDict(current.analyses) ?? {};
    if (!(seg in subAnalyses))
      return mkErr(`Output.from '${ref}': sub-analysis '${seg}' not found at depth ${i}`);
    current = subAnalyses[seg] as Dict;
  }
  const tail = parsed.segments[parsed.segments.length - 1]!;
  if (!getOutputIds(current).has(tail))
    return mkErr(`Output.from '${ref}': output '${tail}' not found in target sub-analysis`);
  return [];
}

function _validateConstraintRef(
  ref: string,
  decisions: Record<string, Dict>,
  optionPath: string,
): SemanticError[] {
  const parts = ref.split(".");
  if (parts.length !== 2) {
    return [
      new SemanticError(
        "INVALID_CONSTRAINT_FORMAT",
        `Constraint '${ref}' should be in 'decision.option' format`,
        optionPath,
      ),
    ];
  }
  const [decisionId, optionId] = parts as [string, string];
  if (!(decisionId in decisions)) {
    return [
      new SemanticError(
        "INVALID_CONSTRAINT_REF",
        `Constraint ref '${ref}' points to non-existent decision '${decisionId}'`,
        optionPath,
      ),
    ];
  }
  const options = getDecisionOptions(decisions[decisionId]!);
  if (!(optionId in options)) {
    return [
      new SemanticError(
        "INVALID_CONSTRAINT_REF",
        `Constraint ref '${ref}' points to non-existent option '${optionId}'`,
        optionPath,
      ),
    ];
  }
  return [];
}

export function validateUniverse(
  universeData: Dict,
  analysisData: Dict,
): SemanticError[] {
  return _validateUniverseNode(universeData, analysisData, "", []);
}

function _validateUniverseNode(
  universeNode: Dict,
  analysisNode: Dict,
  pathPrefix: string,
  ancestorUniverseChain: Record<string, string>[],
): SemanticError[] {
  const errors: SemanticError[] = [];

  const analysisDecisions = collectNodeDecisions(analysisNode) as Record<string, Dict>;
  const allAnalysisDecisions = (asDict(analysisNode.decisions) ?? {}) as Record<string, Dict>;
  const universeDecisions = getDecisionSelections(universeNode);
  const decisionsPath = pathPrefix ? `${pathPrefix}.decisions` : "decisions";

  const fromDecisionIds = new Set<string>();
  for (const [id, decision] of Object.entries(allAnalysisDecisions)) {
    if (decision && (decision as Dict).from) fromDecisionIds.add(id);
  }

  for (const [decisionId, optionId] of Object.entries(universeDecisions)) {
    if (fromDecisionIds.has(decisionId)) {
      errors.push(
        new SemanticError(
          "FROM_DECISION_IN_UNIVERSE",
          `Universe should not set decision '${decisionId}' (it uses 'from' to reference a parent decision)`,
          `${decisionsPath}.${decisionId}`,
        ),
      );
      continue;
    }
    if (!(decisionId in analysisDecisions)) {
      errors.push(
        new SemanticError(
          "UNKNOWN_DECISION",
          `Universe references unknown decision '${decisionId}'`,
          `${decisionsPath}.${decisionId}`,
        ),
      );
      continue;
    }
    const decision = analysisDecisions[decisionId]!;
    const options = getDecisionOptions(decision);
    if (!(optionId in options)) {
      errors.push(
        new SemanticError(
          "UNKNOWN_OPTION",
          `Universe selects unknown option '${optionId}' for decision '${decisionId}'`,
          `${decisionsPath}.${decisionId}`,
        ),
      );
    } else if (options[optionId]!.excluded === true) {
      errors.push(
        new SemanticError(
          "EXCLUDED_OPTION_SELECTED",
          `Universe selects excluded option '${optionId}' for decision '${decisionId}'`,
          `${decisionsPath}.${decisionId}`,
        ),
      );
    }
  }

  // Merge universe selections from this and all ancestor levels for `when:` evaluation.
  const allUniverseDecisions: Record<string, string> = {};
  for (const ancestor of ancestorUniverseChain) Object.assign(allUniverseDecisions, ancestor);
  Object.assign(allUniverseDecisions, universeDecisions);

  for (const decisionId of Object.keys(analysisDecisions)) {
    if (fromDecisionIds.has(decisionId)) continue;
    const decision = analysisDecisions[decisionId]!;
    const when = decision.when as string | string[] | undefined;
    if (when) {
      if (!isConditionMet(when, allUniverseDecisions)) {
        if (decisionId in universeDecisions) {
          errors.push(
            new SemanticError(
              "INACTIVE_DECISION",
              `Universe specifies decision '${decisionId}' but its condition '${JSON.stringify(when)}' is not met`,
              `${decisionsPath}.${decisionId}`,
            ),
          );
        }
        continue;
      }
    }
    if (!(decisionId in universeDecisions)) {
      errors.push(
        new SemanticError(
          "MISSING_DECISION",
          `Universe missing decision '${decisionId}'`,
          `${decisionsPath}.${decisionId}`,
        ),
      );
    }
  }

  // Build effective selections (resolve `from:` from the matching ancestor universe).
  const effective: Record<string, string> = { ...universeDecisions };
  for (const decisionId of fromDecisionIds) {
    const ref = (allAnalysisDecisions[decisionId]!.from as string | undefined) ?? "";
    const parsed = parseFromPath(ref);
    if (!parsed || parsed.up <= 0 || parsed.segments.length !== 1) continue;
    if (parsed.up > ancestorUniverseChain.length) continue;
    const targetUniverse = ancestorUniverseChain[ancestorUniverseChain.length - parsed.up]!;
    const tgt = parsed.segments[0]!;
    if (tgt in targetUniverse) effective[decisionId] = targetUniverse[tgt]!;
  }

  errors.push(..._validateNodeUniverseConstraints(effective, analysisDecisions, decisionsPath));

  const analysisSub: Record<string, Dict> = {};
  for (const [id, raw] of Object.entries(asDict(analysisNode.analyses) ?? {})) {
    const child = asDict(raw);
    if (child) analysisSub[id] = child;
  }
  const universeSub: Record<string, Dict> = {};
  for (const [id, raw] of Object.entries(asDict(universeNode.analyses) ?? {})) {
    const child = asDict(raw);
    if (child) universeSub[id] = child;
  }
  const analysesPrefix = pathPrefix ? `${pathPrefix}.analyses` : "analyses";

  for (const analysisId of Object.keys(universeSub)) {
    if (!(analysisId in analysisSub)) {
      errors.push(
        new SemanticError(
          "UNKNOWN_ANALYSIS",
          `Universe references unknown analysis: ${analysisId}`,
          `${analysesPrefix}.${analysisId}`,
        ),
      );
    }
  }

  for (const [analysisId, sub] of Object.entries(analysisSub)) {
    const subUniverse = (universeSub[analysisId] ?? {}) as Dict;
    errors.push(
      ..._validateUniverseNode(
        subUniverse,
        sub,
        `${analysesPrefix}.${analysisId}`,
        [...ancestorUniverseChain, universeDecisions],
      ),
    );
  }

  return errors;
}

function _validateNodeUniverseConstraints(
  universeDecisions: Record<string, string>,
  analysisDecisions: Record<string, Dict>,
  pathPrefix: string,
): SemanticError[] {
  const errors: SemanticError[] = [];
  for (const [decisionId, optionId] of Object.entries(universeDecisions)) {
    const decision = analysisDecisions[decisionId];
    if (!decision) continue;
    const options = getDecisionOptions(decision);
    const option = options[optionId];
    if (!option) continue;
    const path = `${pathPrefix}.${decisionId}`;

    for (const ref of asArray<string>(option.incompatible_with)) {
      const parts = ref.split(".");
      if (parts.length === 2 && universeDecisions[parts[0]!] === parts[1]!) {
        errors.push(
          new SemanticError(
            "INCOMPATIBLE_OPTIONS",
            `Option '${decisionId}.${optionId}' is incompatible with '${ref}'`,
            path,
          ),
        );
      }
    }
    for (const ref of asArray<string>(option.requires)) {
      const parts = ref.split(".");
      if (parts.length === 2 && universeDecisions[parts[0]!] !== parts[1]!) {
        const actual = universeDecisions[parts[0]!] ?? "(not set)";
        errors.push(
          new SemanticError(
            "MISSING_REQUIRED_OPTION",
            `Option '${decisionId}.${optionId}' requires '${ref}' but got '${actual}'`,
            path,
          ),
        );
      }
    }
  }
  return errors;
}
