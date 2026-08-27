// Hand-curated TypeScript types matching the LinkML schema published at
// https://astra-spec.org/. The shapes are deliberately permissive (string
// IDs, optional fields) — strict structural checks happen in `validation`.

export type InputType = "data" | "analysis";
export type OutputType = "metric" | "figure" | "table" | "data" | "report";

export interface TextQuoteSelector {
  exact: string;
  prefix?: string;
  suffix?: string;
}

export interface FragmentSelector {
  value?: string;
  page?: number;
}

export interface Evidence {
  id: string;
  doi?: string;
  artifact?: string;
  version?: number;
  snapshot?: string;
  source_commit?: string;
  quote?: TextQuoteSelector;
  location?: FragmentSelector;
}

export interface Insight {
  id: string;
  label?: string;
  claim: string;
  created_at: string;
  evidence: Evidence[];
  derived?: boolean;
  scope?: string;
  tags?: string[];
  notes?: string;
}

export interface Resources {
  cpus?: number;
  memory?: string;
  time_limit?: string;
  disk?: string;
  gpus?: number;
}

export interface Recipe {
  command?: string;
  resources?: Resources;
  container?: string;
}

export interface Input {
  id: string;
  label?: string;
  type?: InputType;
  description?: string;
  source?: string;
  ref?: string;
  ref_version?: string;
  use_outputs?: string[];
  from?: string;
}

export interface Output {
  id: string;
  label?: string;
  type?: OutputType;
  /**
   * Serialization of the artifact: the file extension it is written with,
   * without the leading dot (`png`, `csv`, `parquet`, `fits`). Where `type`
   * says what the artifact *is*, this says how it is encoded.
   *
   * Recommended, not required, in ASTRA 0.0.x — required on non-aliased
   * outputs from 0.1.0. Forbidden on a re-export (`from`), which inherits
   * its source's.
   */
  format?: string;
  description?: string;
  inputs?: string[];
  decisions?: string[];
  recipe?: Recipe;
  from?: string;
  when?: string[];
}

export interface Option {
  id?: string;
  label: string;
  description?: string;
  insights?: string[];
  incompatible_with?: string[];
  requires?: string[];
  excluded?: boolean;
  excluded_reason?: string;
}

export interface Decision {
  id?: string;
  label?: string;
  rationale?: string;
  tags?: string[];
  default?: string;
  /** A string value is shorthand for an option whose label is that string. */
  options?: Record<string, Option | string>;
  from?: string;
  when?: string[];
}

export interface Analysis {
  id?: string;
  version?: string;
  name?: string;
  description?: string;
  tags?: string[];
  inputs?: Input[];
  outputs?: Output[];
  decisions?: Record<string, Decision>;
  prior_insights?: Record<string, Insight>;
  findings?: Record<string, Insight>;
  container?: string;
  path?: string;
  analyses?: Record<string, Analysis>;
}

export interface DecisionSelection {
  /** Optional because the surrounding map key identifies the decision. */
  decision_id?: string | null;
  option_id: string;
}

export interface UniverseNode {
  id?: string;
  universe?: string | null;
  decisions?: Record<string, string | DecisionSelection>;
  analyses?: Record<string, UniverseNode>;
}

export interface Universe {
  id: string;
  description?: string;
  decisions?: Record<string, string | DecisionSelection>;
  analyses?: Record<string, UniverseNode>;
}
