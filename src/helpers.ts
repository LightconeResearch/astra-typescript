import { parse as parseYaml } from "yaml";

import type { Decision, Input, Output } from "./types.js";

export type Dict = Record<string, unknown>;

export function asDict(v: unknown): Dict | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : undefined;
}

export function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export function parseYamlString(text: string): Dict {
  const data = parseYaml(text);
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("YAML root must be a mapping/object");
  }
  return data as Dict;
}

/** Evaluate a `when` clause against a flat decision selection. AND across
 *  entries; `~` prefix negates. */
export function isConditionMet(
  when: string | string[] | undefined | null,
  selections: Record<string, string>,
): boolean {
  if (when == null) return true;
  const conditions = typeof when === "string" ? [when] : when;
  for (const cond of conditions) {
    const negate = cond.startsWith("~");
    const ref = negate ? cond.slice(1) : cond;
    const dot = ref.indexOf(".");
    if (dot < 0) return false;
    const decisionId = ref.slice(0, dot);
    const optionId = ref.slice(dot + 1);
    const selected = selections[decisionId];
    let match = selected === optionId;
    if (negate) match = !match;
    if (!match) return false;
  }
  return true;
}

/** Locally-defined decisions on a node — `from:` aliases are skipped. */
export function collectNodeDecisions(node: Dict): Record<string, Decision> {
  const out: Record<string, Decision> = {};
  const decisions = (node.decisions ?? {}) as Record<string, Decision>;
  for (const [id, decision] of Object.entries(decisions)) {
    if (decision && typeof decision === "object" && (decision as Decision).from) continue;
    out[id] = decision;
  }
  return out;
}

export function getInputIds(node: Dict): Set<string> {
  const out = new Set<string>();
  for (const inp of asArray<Input>(node.inputs)) if (inp?.id) out.add(inp.id);
  return out;
}

export function getOutputIds(node: Dict): Set<string> {
  const out = new Set<string>();
  for (const o of asArray<Output>(node.outputs)) if (o?.id) out.add(o.id);
  return out;
}

function injectMapKeysAsIds(map: Dict, recurse?: (value: Dict) => void): void {
  for (const [key, value] of Object.entries(map)) {
    const obj = asDict(value);
    if (!obj) continue;
    if (obj.id === undefined) obj.id = key;
    if (recurse) recurse(obj);
  }
}

/** ASTRA YAML uses keyed dicts but the JSON Schema requires explicit `id`
 *  fields; this fills them in from the keys. Mutates `data` in place. */
export function injectAnalysisIdsInPlace(data: Dict): void {
  for (const field of ["decisions", "analyses", "prior_insights", "findings"] as const) {
    const mapping = asDict(data[field]);
    if (!mapping) continue;
    injectMapKeysAsIds(mapping, (value) => {
      if (field === "decisions") {
        const opts = asDict(value.options);
        if (opts) injectMapKeysAsIds(opts);
      } else if (field === "analyses") {
        injectAnalysisIdsInPlace(value);
      }
    });
  }
}

export function injectUniverseIdsInPlace(node: Dict): void {
  const analyses = asDict(node.analyses);
  if (!analyses) return;
  injectMapKeysAsIds(analyses, injectUniverseIdsInPlace);
}
