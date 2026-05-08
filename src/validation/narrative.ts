// Narrative validation: anchor resolution, coverage warnings, and the
// section-required-when-data-present rule.

import { loadYaml, resolveAnalysisTree } from "../helpers.js";
import { SemanticError } from "./semantic.js";

const HREF_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;
const PARENT_PATH_FORM_RE = /^(?:\.\.\/)+#/;

const CATEGORIES = new Set([
  "inputs",
  "outputs",
  "decisions",
  "findings",
  "prior_insights",
  "analyses",
]);

const ANALYSES_PREFIX_FORM_RE = new RegExp(
  `^analyses\\.[^.]+\\.(?:${[...CATEGORIES].sort().join("|")})(?:\\.|$)`,
);

const COVERAGE_LABELS: Record<string, string> = {
  decisions: "Decision",
  findings: "Finding",
  outputs: "Output",
  analyses: "Sub-analysis",
};

const NARRATIVE_SECTIONS = ["summary", "findings", "methods", "inputs", "outputs"] as const;

type Dict = Record<string, unknown>;

function asDict(v: unknown): Dict | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export class NarrativeWarning {
  constructor(
    public readonly code: string,
    public readonly message: string,
    public readonly path?: string,
  ) {}
  toString(): string {
    return this.path ? `[${this.code}] ${this.path}: ${this.message}` : `[${this.code}] ${this.message}`;
  }
}

interface ParsedAnchor {
  raw: string;
  upLevels: number;
  subPath: string[];
  category: string;
  elementId: string;
  optionId: string | null;
}

function parseAnchor(raw: string): ParsedAnchor | null {
  let up = 0;
  let remaining = raw;
  while (remaining.startsWith("../")) {
    up += 1;
    remaining = remaining.slice(3);
  }
  if (!remaining) return null;
  const segments = remaining.split(".");
  if (segments.some((s) => !s)) return null;
  let catIdx = -1;
  for (let i = 0; i < segments.length; i++) {
    if (CATEGORIES.has(segments[i]!)) {
      catIdx = i;
      break;
    }
  }
  if (catIdx === -1) return null;
  const subPath = segments.slice(0, catIdx);
  const category = segments[catIdx]!;
  const tail = segments.slice(catIdx + 1);
  if (tail.length === 0) return null;
  const elementId = tail[0]!;
  let optionId: string | null = null;
  if (category === "decisions") {
    if (tail.length === 3 && tail[1] === "options") optionId = tail[2]!;
    else if (tail.length > 1) return null;
  } else if (tail.length > 1) {
    return null;
  }
  return { raw, upLevels: up, subPath, category, elementId, optionId };
}

function getNodeAt(root: Dict, path: string[]): Dict | null {
  let current: Dict = root;
  for (const seg of path) {
    const analyses = asDict(current.analyses) ?? {};
    if (!(seg in analyses)) return null;
    const next = asDict(analyses[seg]);
    if (!next) return null;
    current = next;
  }
  return current;
}

function lookupElement(node: Dict, category: string, elementId: string, optionId: string | null): boolean {
  if (category === "inputs") {
    const ids = (asArray(node.inputs) as Dict[]).map((i) => i?.id as string | undefined).filter(Boolean);
    return ids.includes(elementId);
  }
  if (category === "outputs") {
    const ids = (asArray(node.outputs) as Dict[]).map((o) => o?.id as string | undefined).filter(Boolean);
    return ids.includes(elementId);
  }
  if (category === "decisions") {
    const decisions = asDict(node.decisions) ?? {};
    if (!(elementId in decisions)) return false;
    if (optionId === null) return true;
    const options = asDict((decisions[elementId] as Dict).options) ?? {};
    return optionId in options;
  }
  if (category === "findings") return elementId in (asDict(node.findings) ?? {});
  if (category === "prior_insights") return elementId in (asDict(node.prior_insights) ?? {});
  if (category === "analyses") return elementId in (asDict(node.analyses) ?? {});
  return false;
}

function resolveAnchor(
  anchor: ParsedAnchor,
  hostingPath: string[],
  root: Dict,
): { targetPath: string[]; category: string; elementId: string; optionId: string | null } | null {
  if (anchor.upLevels > hostingPath.length) return null;
  const base = hostingPath.slice(0, hostingPath.length - anchor.upLevels);
  const targetPath = [...base, ...anchor.subPath];
  const targetNode = getNodeAt(root, targetPath);
  if (!targetNode) return null;
  if (!lookupElement(targetNode, anchor.category, anchor.elementId, anchor.optionId)) return null;
  return { targetPath, category: anchor.category, elementId: anchor.elementId, optionId: anchor.optionId };
}

function* iterSections(narrative: unknown): Generator<[string, string]> {
  const dict = asDict(narrative);
  if (!dict) return;
  for (const section of NARRATIVE_SECTIONS) {
    const content = dict[section];
    if (typeof content === "string" && content) yield [section, content];
  }
}

function* extractSectionHrefs(narrative: unknown): Generator<[string, string]> {
  for (const [section, content] of iterSections(narrative)) {
    HREF_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HREF_RE.exec(content)) !== null) {
      yield [section, match[1]!];
    }
  }
}

function nodePathStr(path: string[]): string {
  return path.map((seg) => `analyses.${seg}`).join(".");
}

function narrativeReportPath(base: string, section: string): string {
  return base ? `${base}.narrative.${section}` : `narrative.${section}`;
}

export function validateNarrativeAnchors(
  data: Dict,
  options: { basePath?: string } = {},
): SemanticError[] {
  let working = data;
  if (options.basePath) working = resolveAnalysisTree(data, options.basePath);
  const errors: SemanticError[] = [];
  walkAnchors(working, [], working, errors);
  return errors;
}

function walkAnchors(node: Dict, path: string[], root: Dict, errors: SemanticError[]): void {
  const narrative = node.narrative;
  if (narrative) {
    const base = nodePathStr(path);
    for (const [section, href] of extractSectionHrefs(narrative)) {
      const narrPath = narrativeReportPath(base, section);
      if (PARENT_PATH_FORM_RE.test(href)) {
        errors.push(
          new SemanticError(
            "INVALID_NARRATIVE_ANCHOR",
            `Anchor '${href}' uses non-canonical parent escape; move '../' inside the fragment ` +
              `(e.g. '#../target' instead of '../#target')`,
            narrPath,
          ),
        );
        continue;
      }
      if (!href.startsWith("#")) continue;
      const raw = href.slice(1);
      if (!raw.includes(".")) continue;
      const parsed = parseAnchor(raw);
      if (!parsed) {
        let stripped = raw;
        while (stripped.startsWith("../")) stripped = stripped.slice(3);
        if (ANALYSES_PREFIX_FORM_RE.test(stripped)) {
          errors.push(
            new SemanticError(
              "INVALID_NARRATIVE_ANCHOR",
              `Anchor '${href}' starts with 'analyses.<sub>' but drilling below the sub-analysis ` +
                `node uses the tree-path form: write '#<sub>.<category>.<id>' (or ` +
                `'#../<sib>.<category>.<id>' from a sibling) instead.`,
              narrPath,
            ),
          );
          continue;
        }
        errors.push(
          new SemanticError(
            "INVALID_NARRATIVE_ANCHOR",
            `Anchor '#${raw}' does not match the narrative anchor grammar`,
            narrPath,
          ),
        );
        continue;
      }
      if (resolveAnchor(parsed, path, root) === null) {
        errors.push(
          new SemanticError(
            "BROKEN_NARRATIVE_ANCHOR",
            `Anchor '#${raw}' does not resolve to a declared element`,
            narrPath,
          ),
        );
      }
    }
  }
  const subAnalyses = asDict(node.analyses) ?? {};
  for (const [subId, raw] of Object.entries(subAnalyses)) {
    const sub = asDict(raw);
    if (sub) walkAnchors(sub, [...path, subId], root, errors);
  }
}

export function checkNarrativeCoverage(
  data: Dict,
  options: { basePath?: string } = {},
): NarrativeWarning[] {
  let working = data;
  if (options.basePath) working = resolveAnalysisTree(data, options.basePath);
  const mentioned = new Set<string>();
  collectMentioned(working, [], working, mentioned);
  const warnings: NarrativeWarning[] = [];
  walkCoverage(working, [], mentioned, warnings);
  return warnings;
}

function mentionKey(path: string[], category: string, elementId: string): string {
  return `${path.join("/")}|${category}|${elementId}`;
}

function collectMentioned(node: Dict, path: string[], root: Dict, mentioned: Set<string>): void {
  const narrative = node.narrative;
  if (narrative) {
    for (const [, href] of extractSectionHrefs(narrative)) {
      if (!href.startsWith("#")) continue;
      const raw = href.slice(1);
      if (!raw.includes(".")) continue;
      const parsed = parseAnchor(raw);
      if (!parsed) continue;
      const resolved = resolveAnchor(parsed, path, root);
      if (!resolved) continue;
      mentioned.add(mentionKey(resolved.targetPath, resolved.category, resolved.elementId));
      // Each ancestor sub-analysis along the resolved target counts as mentioned.
      for (let i = 0; i < resolved.targetPath.length; i++) {
        mentioned.add(mentionKey(resolved.targetPath.slice(0, i), "analyses", resolved.targetPath[i]!));
      }
    }
  }
  const subAnalyses = asDict(node.analyses) ?? {};
  for (const [subId, raw] of Object.entries(subAnalyses)) {
    const sub = asDict(raw);
    if (sub) collectMentioned(sub, [...path, subId], root, mentioned);
  }
}

function* iterCoverageIds(node: Dict, category: string): Generator<string> {
  if (category === "decisions") {
    const decisions = asDict(node.decisions) ?? {};
    for (const [did, decision] of Object.entries(decisions)) {
      if (decision && (decision as Dict).from) continue;
      yield did;
    }
  } else if (category === "outputs") {
    for (const out of asArray(node.outputs) as Dict[]) {
      const oid = out?.id as string | undefined;
      if (oid) yield oid;
    }
  } else {
    yield* Object.keys(asDict(node[category]) ?? {});
  }
}

function walkCoverage(
  node: Dict,
  path: string[],
  mentioned: Set<string>,
  warnings: NarrativeWarning[],
): void {
  const base = nodePathStr(path);
  for (const [category, label] of Object.entries(COVERAGE_LABELS)) {
    for (const eid of iterCoverageIds(node, category)) {
      if (mentioned.has(mentionKey(path, category, eid))) continue;
      const elementPath = base ? `${base}.${category}.${eid}` : `${category}.${eid}`;
      warnings.push(
        new NarrativeWarning(
          "NARRATIVE_UNMENTIONED",
          `${label} '${eid}' is not mentioned in any narrative`,
          elementPath,
        ),
      );
    }
  }
  const subAnalyses = asDict(node.analyses) ?? {};
  for (const [subId, raw] of Object.entries(subAnalyses)) {
    const sub = asDict(raw);
    if (sub) walkCoverage(sub, [...path, subId], mentioned, warnings);
  }
}

const DATA_TRIGGERED_SECTIONS: Record<string, string[]> = {
  findings: ["findings"],
  methods: ["decisions", "analyses"],
  inputs: ["inputs"],
  outputs: ["outputs"],
};

export function validateNarrativeSections(
  data: Dict,
  options: { basePath?: string } = {},
): SemanticError[] {
  let working = data;
  if (options.basePath) working = resolveAnalysisTree(data, options.basePath);
  const errors: SemanticError[] = [];
  walkSectionRequirements(working, [], errors);
  return errors;
}

function walkSectionRequirements(node: Dict, path: string[], errors: SemanticError[]): void {
  const narrative = asDict(node.narrative) ?? {};
  const base = nodePathStr(path);
  for (const [section, triggers] of Object.entries(DATA_TRIGGERED_SECTIONS)) {
    const present = triggers.filter((k) => {
      const v = node[k];
      if (Array.isArray(v)) return v.length > 0;
      if (v && typeof v === "object") return Object.keys(v).length > 0;
      return Boolean(v);
    });
    if (present.length === 0) continue;
    const content = narrative[section];
    if (typeof content === "string" && content.trim()) continue;
    const triggersStr = present.map((k) => `'${k}'`).join(" and ");
    errors.push(
      new SemanticError(
        "NARRATIVE_SECTION_REQUIRED",
        `Narrative section '${section}' is required because ${triggersStr} has entries`,
        narrativeReportPath(base, section),
      ),
    );
  }
  const subAnalyses = asDict(node.analyses) ?? {};
  for (const [subId, raw] of Object.entries(subAnalyses)) {
    const sub = asDict(raw);
    if (sub) walkSectionRequirements(sub, [...path, subId], errors);
  }
}

import { dirname } from "node:path";

export function validateNarrativeAnchorsFile(filePath: string): SemanticError[] {
  return validateNarrativeAnchors(loadYaml(filePath), { basePath: dirname(filePath) });
}

export function checkNarrativeCoverageFile(filePath: string): NarrativeWarning[] {
  return checkNarrativeCoverage(loadYaml(filePath), { basePath: dirname(filePath) });
}

export function validateNarrativeSectionsFile(filePath: string): SemanticError[] {
  return validateNarrativeSections(loadYaml(filePath), { basePath: dirname(filePath) });
}
