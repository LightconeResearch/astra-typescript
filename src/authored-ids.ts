type Mapping = Record<string, unknown>;

function asMapping(value: unknown): Mapping | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Mapping
    : undefined;
}

function injectMapIds(map: Mapping, visit?: (value: Mapping) => void): void {
  for (const [id, raw] of Object.entries(map)) {
    const value = asMapping(raw);
    if (!value) continue;
    if (value.id == null) value.id = id;
    visit?.(value);
  }
}

/** Fill identifiers carried by map keys for one authored analysis node. */
export function injectAnalysisNodeIds(data: Mapping): void {
  for (const field of ["decisions", "prior_insights", "findings"] as const) {
    const mapping = asMapping(data[field]);
    if (!mapping) continue;
    injectMapIds(mapping, (value) => {
      if (field !== "decisions") return;
      const options = asMapping(value.options);
      if (options) injectMapIds(options);
    });
  }
}

/** Fill all identifiers before validating an authored analysis tree. */
export function injectAnalysisTreeIds(data: Mapping): void {
  injectAnalysisNodeIds(data);
  const analyses = asMapping(data.analyses);
  if (!analyses) return;
  injectMapIds(analyses, injectAnalysisTreeIds);
}

/** Fill nested analysis identifiers in an authored universe tree. */
export function injectUniverseTreeIds(data: Mapping): void {
  const analyses = asMapping(data.analyses);
  if (analyses) injectMapIds(analyses, injectUniverseTreeIds);
}
