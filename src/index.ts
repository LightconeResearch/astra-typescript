export type {
  Analysis,
  Decision,
  DecisionSelection,
  Evidence,
  FragmentSelector,
  Input,
  InputType,
  Insight,
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
  parseYamlString,
  isConditionMet,
  collectNodeDecisions,
  injectAnalysisIdsInPlace,
  injectUniverseIdsInPlace,
  getInputIds,
  getOutputIds,
} from "./helpers.js";

export {
  validateAnalysisData,
  validateUniverseData,
  validateAnalysisStructure,
  validateUniverseStructure,
  type SchemaValidationIssue,
  SemanticError,
  validateAnalysis,
  validateUniverse,
  RECOMMENDED_UNTIL,
  collectRecommendations,
} from "./validation/index.js";

export {
  type JsonSchema,
  type SchemaLoadOptions,
  ASTRA_SPEC_HOST,
  ASTRA_SPEC_VERSION,
  astraSchemaUrl,
  loadAstraSchema,
  setAstraSchema,
  clearAstraSchemaCache,
} from "./schema/index.js";

export type {
  ProjectReader,
  ProjectEntry,
  ProjectDirectoryEntry,
} from "./project-reader.js";
export {
  ProjectPathError,
  assertProjectPath,
  joinProjectPath,
  projectDirname,
} from "./project-reader.js";

export * from "./resolved-types.js";
export * from "./resolve.js";
export * from "./index-analysis.js";
export * from "./citations.js";
