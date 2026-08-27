import { join, resolve } from "node:path";

const FIXTURES_DIR = resolve(__dirname, "fixtures");

export const FIXTURES = {
  irisAnalysis: join(FIXTURES_DIR, "examples/iris/astra.yaml"),
  irisPipelineAnalysis: join(FIXTURES_DIR, "examples/iris_pipeline/astra.yaml"),
} as const;
