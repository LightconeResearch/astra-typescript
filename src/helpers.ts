// Dict-based helpers that operate on parsed YAML data structures. Mirrors
// the Python `astra.helpers` module so semantic validation can resolve
// `from:` paths, `when:` conditions, and tree lookups without requiring a
// strongly-typed model.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";

import type { Analysis, Decision, Input, Output, Universe } from "./types.js";

/** Parse a YAML string into an unknown record. */
export function parseYamlString(text: string): Record<string, unknown> {
  const data = parseYaml(text);
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("YAML root must be a mapping/object");
  }
  return data as Record<string, unknown>;
}

/** Read a YAML file from disk as a parsed object. */
export function loadYaml(filePath: string): Record<string, unknown> {
  const text = readFileSync(filePath, "utf8");
  return parseYamlString(text);
}

/** Evaluate a `when` clause (string | string[] | undefined) against a
 *  flat decision selection. AND across entries; `~` prefix negates. */
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

/** Locally-defined decisions on a node (skips `from:` aliases). */
export function collectNodeDecisions(
  node: Record<string, unknown>,
): Record<string, Decision> {
  const out: Record<string, Decision> = {};
  const decisions = (node.decisions ?? {}) as Record<string, Decision>;
  for (const [id, decision] of Object.entries(decisions)) {
    if (decision && typeof decision === "object" && (decision as Decision).from) continue;
    out[id] = decision;
  }
  return out;
}

export function getInputIds(node: Record<string, unknown>): Set<string> {
  const inputs = (node.inputs ?? []) as Input[];
  const out = new Set<string>();
  for (const inp of inputs) if (inp?.id) out.add(inp.id);
  return out;
}

export function getOutputIds(node: Record<string, unknown>): Set<string> {
  const outputs = (node.outputs ?? []) as Output[];
  const out = new Set<string>();
  for (const o of outputs) if (o?.id) out.add(o.id);
  return out;
}

/** Walk `analyses.*.path` references and inline external `astra.yaml`
 *  files. Returns a new object only if at least one path was resolved. */
export function resolveAnalysisTree(
  data: Record<string, unknown>,
  basePath: string,
): Record<string, unknown> {
  const analyses = data.analyses;
  if (!analyses || typeof analyses !== "object") return data;

  const resolved: Record<string, unknown> = {};
  let changed = false;
  for (const [id, raw] of Object.entries(analyses)) {
    if (!raw || typeof raw !== "object") {
      resolved[id] = raw;
      continue;
    }
    const node = raw as Record<string, unknown>;
    const subPath = node.path;
    if (typeof subPath === "string" && subPath) {
      const absDir = isAbsolute(subPath) ? subPath : resolvePath(basePath, subPath);
      const yamlPath = resolvePath(absDir, "astra.yaml");
      try {
        const subData = loadYaml(yamlPath);
        subData.path = subPath;
        resolved[id] = resolveAnalysisTree(subData, absDir);
        changed = true;
      } catch {
        // If the file doesn't exist, leave the stub in place — a
        // higher-layer warning surfaces the problem.
        resolved[id] = node;
      }
    } else {
      const sub = resolveAnalysisTree(node, basePath);
      resolved[id] = sub;
      if (sub !== node) changed = true;
    }
  }

  if (!changed) return data;
  return { ...data, analyses: resolved };
}

/** Inject mapping keys as `id` fields on each value, mirroring the
 *  Python-side preprocessing. ASTRA YAML is keyed-dict, but the JSON
 *  Schema requires `id` to be set. Mutates the supplied data in place. */
export function injectAnalysisIdsInPlace(data: Record<string, unknown>): void {
  for (const field of ["decisions", "analyses", "prior_insights", "findings"]) {
    const mapping = data[field];
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) continue;
    for (const [key, value] of Object.entries(mapping as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const obj = value as Record<string, unknown>;
      if (obj.id === undefined) obj.id = key;
      if (field === "decisions") {
        const opts = obj.options;
        if (opts && typeof opts === "object" && !Array.isArray(opts)) {
          for (const [okey, ovalue] of Object.entries(opts as Record<string, unknown>)) {
            if (ovalue && typeof ovalue === "object" && !Array.isArray(ovalue)) {
              const o = ovalue as Record<string, unknown>;
              if (o.id === undefined) o.id = okey;
            }
          }
        }
      }
      if (field === "analyses") {
        injectAnalysisIdsInPlace(obj);
      }
    }
  }
}

export function injectUniverseIdsInPlace(node: Record<string, unknown>): void {
  const analyses = node.analyses;
  if (!analyses || typeof analyses !== "object" || Array.isArray(analyses)) return;
  for (const [key, value] of Object.entries(analyses as Record<string, unknown>)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if (obj.id === undefined) obj.id = key;
      injectUniverseIdsInPlace(obj);
    }
  }
}

/** Deep clone via JSON round-trip. ASTRA documents are pure data — no
 *  cycles, no functions — so this is sufficient and avoids a dep. */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function dirOf(filePath: string): string {
  return dirname(filePath);
}

// Re-export type utility for consumers that want strongly-typed outputs.
export type { Analysis, Universe };
