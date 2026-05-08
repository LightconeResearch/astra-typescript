// Public API for @astra-spec/sdk. The package focuses on parsing and
// validating ASTRA analyses; downstream tools layer their own UX on top.

export type {
  Analysis,
  Decision,
  Evidence,
  FragmentSelector,
  Input,
  InputType,
  Insight,
  Narrative,
  Option,
  Output,
  OutputType,
  Recipe,
  Resources,
  TextQuoteSelector,
  Universe,
  UniverseNode,
} from "./types.js";

export {
  loadYaml,
  parseYamlString,
  isConditionMet,
  collectNodeDecisions,
  resolveAnalysisTree,
  injectAnalysisIdsInPlace,
  injectUniverseIdsInPlace,
  getInputIds,
  getOutputIds,
} from "./helpers.js";

export {
  // Structural (JSON Schema)
  validateAnalysisData,
  validateUniverseData,
  validateAnalysisFile,
  validateUniverseFile,
  isValidAnalysis,
  isValidUniverse,

  // Semantic
  SemanticError,
  validateAnalysis,
  validateUniverse,
  semanticValidateAnalysisFile,
  semanticValidateUniverseFile,

  // Narrative
  NarrativeWarning,
  validateNarrativeAnchors,
  validateNarrativeAnchorsFile,
  checkNarrativeCoverage,
  checkNarrativeCoverageFile,
  validateNarrativeSections,
  validateNarrativeSectionsFile,
} from "./validation/index.js";

export {
  type JsonSchema,
  type SchemaLoadOptions,
  ASTRA_SPEC_HOST,
  astraSchemaUrl,
  loadAstraSchema,
  setAstraSchema,
  clearAstraSchemaCache,
} from "./schema/index.js";
