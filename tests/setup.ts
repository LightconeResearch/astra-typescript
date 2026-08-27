import { join, resolve } from "node:path";

const FIXTURES_DIR = resolve(__dirname, "fixtures");

export const FIXTURES = {
  validAnalysis: join(FIXTURES_DIR, "valid/Analysis-001.yaml"),
  validUniverse: join(FIXTURES_DIR, "valid/Universe-001.yaml"),
  invalidDir: join(FIXTURES_DIR, "invalid"),
  irisAnalysis: join(FIXTURES_DIR, "examples/iris/astra.yaml"),
  irisUniverseBaseline: join(FIXTURES_DIR, "examples/iris/universes/baseline.yaml"),
  irisPipelineAnalysis: join(FIXTURES_DIR, "examples/iris_pipeline/astra.yaml"),
} as const;
