import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AnalysisValidationError,
  resolveAnalysis,
  validateAnalysis,
  type AnalysisValidationResult,
  type ProjectReader,
  type ValidationIssue,
} from "../src/index.js";
import { createNodeProjectReader } from "../src/node.js";
import { FIXTURES } from "./setup.js";

const VALID_ANALYSIS = `version: "0.0.14"
name: Compiler fixture
inputs: []
outputs: []
`;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "astra-compiler-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function reader(): ProjectReader {
  return createNodeProjectReader(root);
}

async function writeAnalysis(yaml: string, directory = root): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "astra.yaml"), yaml);
}

async function writeUniverse(
  name: string,
  yaml: string,
  directory = root,
  extension: "yaml" | "yml" = "yaml",
): Promise<void> {
  const universes = join(directory, "universes");
  await mkdir(universes, { recursive: true });
  await writeFile(join(universes, `${name}.${extension}`), yaml);
}

function issueCodes(result: AnalysisValidationResult): string[] {
  return result.issues.map((issue) => issue.code);
}

async function expectSemanticIssues(
  yaml: string,
  expectedCodes: string[],
): Promise<AnalysisValidationResult> {
  await writeAnalysis(yaml);
  const result = await validateAnalysis(reader());
  expect(result.valid).toBe(false);
  expect(issueCodes(result)).toEqual(expect.arrayContaining(expectedCodes));
  expect(
    result.issues.filter((issue) => issue.code.startsWith("SCHEMA_")),
    "the negative fixture must remain structurally valid",
  ).toEqual([]);
  return result;
}

function issuesFrom(error: unknown): readonly ValidationIssue[] {
  expect(error).toBeInstanceOf(AnalysisValidationError);
  return (error as AnalysisValidationError).issues;
}

describe("validateAnalysis public contract", () => {
  it.each([
    ["iris", FIXTURES.irisAnalysis],
    ["iris pipeline", FIXTURES.irisPipelineAnalysis],
  ])("validates the canonical %s project through the public API", async (_name, analysis) => {
    await cp(dirname(analysis), root, { recursive: true });

    await expect(validateAnalysis(reader())).resolves.toEqual({ valid: true, issues: [] });
  });

  it("returns an immutable-shaped success result for a valid project", async () => {
    await writeAnalysis(VALID_ANALYSIS);

    await expect(validateAnalysis(reader())).resolves.toEqual({ valid: true, issues: [] });
  });

  it("returns authored invalidity while resolveAnalysis throws exactly the same issues", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Parity
inputs: []
outputs:
  - id: result
    type: data
    format: json
    inputs: [missing_a, missing_b]
decisions:
  mode:
    label: Mode
    default: absent
    options:
      present: { label: Present }
`);

    const validation = await validateAnalysis(reader());
    expect(validation.valid).toBe(false);
    expect(issueCodes(validation)).toEqual(expect.arrayContaining([
      "INVALID_DEFAULT",
      "INVALID_OUTPUT_INPUT",
    ]));

    try {
      await resolveAnalysis(reader());
      throw new Error("expected resolveAnalysis to reject");
    } catch (error) {
      expect(issuesFrom(error)).toEqual(validation.issues);
    }
  });

  it("keeps distinct issues with the same code, file, and authored path", async () => {
    const result = await expectSemanticIssues(`version: "0.0.14"
name: Complete issue set
inputs: []
outputs:
  - id: result
    type: data
    format: json
    inputs: [missing_a, missing_b]
`, ["INVALID_OUTPUT_INPUT"]);

    const missing = result.issues.filter((issue) => issue.code === "INVALID_OUTPUT_INPUT");
    expect(missing).toHaveLength(2);
    expect(missing.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      expect.stringContaining("missing_a"),
      expect.stringContaining("missing_b"),
    ]));
    expect(missing.every((issue) => issue.file === "astra.yaml")).toBe(true);
    expect(missing.every((issue) => issue.path === "outputs.result.inputs")).toBe(true);
  });

  it("returns invalid YAML as a validation issue and preserves resolve parity", async () => {
    await writeAnalysis("key: [unclosed\n");

    const validation = await validateAnalysis(reader());
    expect(validation).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ code: "INVALID_YAML", file: "astra.yaml" })],
    });
    try {
      await resolveAnalysis(reader());
      throw new Error("expected resolveAnalysis to reject");
    } catch (error) {
      expect(issuesFrom(error)).toEqual(validation.issues);
    }
  });

  it("reports recursive YAML aliases instead of leaking a raw exception", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Recursive YAML
inputs: &loop
  - *loop
outputs: []
`);

    const validation = await validateAnalysis(reader());
    expect(validation).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ code: "INVALID_YAML", file: "astra.yaml" })],
    });
    await expect(resolveAnalysis(reader())).rejects.toMatchObject({
      name: "AnalysisValidationError",
      issues: validation.issues,
    });
  });

  it("rejects YAML collection tags that cannot round-trip through JSON", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Non-JSON YAML
inputs: []
outputs: []
prior_insights:
  source:
    claim: A claim.
    created_at: "2026-01-01T00:00:00Z"
    evidence:
      - id: cited
        doi: 10.1234/example
        location: !!omap
          - page: 3
`);

    const validation = await validateAnalysis(reader());
    expect(validation).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({
        code: "INVALID_YAML",
        file: "astra.yaml",
        message: expect.stringContaining("JSON-compatible"),
      })],
    });
    await expect(resolveAnalysis(reader())).rejects.toMatchObject({
      name: "AnalysisValidationError",
      issues: validation.issues,
    });
  });

  it.each([".inf", "-.inf", ".nan", "1e999"])(
    "rejects the non-finite YAML number %s",
    async (number) => {
      await writeAnalysis(`version: "0.0.14"
name: Non-finite YAML number
inputs: []
outputs:
  - id: result
    type: data
    format: json
    recipe:
      command: run
      resources:
        cpus: ${number}
`);

      const validation = await validateAnalysis(reader());
      expect(validation).toMatchObject({
        valid: false,
        issues: [expect.objectContaining({
          code: "INVALID_YAML",
          file: "astra.yaml",
          message: expect.stringContaining("JSON-compatible"),
        })],
      });
      await expect(resolveAnalysis(reader())).rejects.toMatchObject({
        name: "AnalysisValidationError",
        issues: validation.issues,
      });
    },
  );

  it("treats null object fields as absent before structural validation", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Nullable required values
inputs:
  - id: null
    type: data
  - id: source
    from: null
outputs:
  - id: null
    type: data
  - id: result
    from: null
`);

    const validation = await validateAnalysis(reader());
    expect(validation.valid).toBe(false);
    const requiredPaths = validation.issues
      .filter((issue) => issue.code === "SCHEMA_REQUIRED")
      .map((issue) => issue.path);
    expect(requiredPaths).toEqual(expect.arrayContaining([
      "inputs.0.id",
      "inputs.1.type",
      "outputs.0.id",
      "outputs.1.type",
    ]));
    await expect(resolveAnalysis(reader())).rejects.toMatchObject({
      name: "AnalysisValidationError",
      issues: validation.issues,
    });
  });

  it("phase-gates schema-invalid documents before semantic linking", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Structurally invalid
inputs: []
outputs:
  - id: result
    type: impossible
    format: json
    inputs: [missing]
`);

    const validation = await validateAnalysis(reader());
    expect(validation.valid).toBe(false);
    expect(issueCodes(validation)).toContain("SCHEMA_ENUM");
    expect(issueCodes(validation)).not.toContain("INVALID_OUTPUT_INPUT");
    expect(validation.issues.every((issue) => issue.code.startsWith("SCHEMA_"))).toBe(true);
  });

  it("keeps a missing project root exceptional", async () => {
    await expect(validateAnalysis(reader())).rejects.toMatchObject({
      name: "ProjectLoadError",
      code: "PROJECT_NOT_FOUND",
    });
  });

  it("rejects malformed metadata returned by a ProjectReader", async () => {
    const malformedReader: ProjectReader = {
      readText: async () => VALID_ANALYSIS,
      stat: async () => ({
        type: "other",
        size: 0,
        modifiedAtMs: 0,
      }) as never,
      readDirectory: async () => [],
    };

    await expect(validateAnalysis(malformedReader)).rejects.toMatchObject({
      name: "ProjectLoadError",
      code: "READ_FAILED",
      path: "astra.yaml",
    });
  });

  it("keeps a caller-requested unknown root universe exceptional", async () => {
    await writeAnalysis(VALID_ANALYSIS);
    await expect(resolveAnalysis(reader(), { universeId: "absent" })).rejects.toMatchObject({
      name: "ProjectLoadError",
      code: "UNIVERSE_NOT_FOUND",
    });
  });

  it("returns a missing declared analysis as authored invalidity", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Missing child
inputs: []
outputs: []
analyses:
  child:
    path: packages/child
`);
    const validation = await validateAnalysis(reader());
    expect(validation).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({
        code: "ANALYSIS_FILE_NOT_FOUND",
        file: "astra.yaml",
        path: "analyses.child",
      })],
    });
    try {
      await resolveAnalysis(reader());
      throw new Error("expected resolveAnalysis to reject");
    } catch (error) {
      expect(issuesFrom(error)).toEqual(validation.issues);
    }
  });
});

describe("configuration-independent compiler rules", () => {
  it("requires root fields in every physical astra.yaml", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Root
inputs: []
outputs: []
analyses:
  child:
    path: packages/child
`);
    await writeAnalysis(`id: child
inputs: []
outputs: []
`, join(root, "packages", "child"));

    const result = await validateAnalysis(reader());
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "MISSING_ROOT_FIELD",
        file: "packages/child/astra.yaml",
        path: "version",
      }),
      expect.objectContaining({
        code: "MISSING_ROOT_FIELD",
        file: "packages/child/astra.yaml",
        path: "name",
      }),
    ]));
    expect(result.issues.some((issue) => issue.code.startsWith("SCHEMA_"))).toBe(false);
  });

  it("requires inputs and outputs on inline analyses", async () => {
    await expectSemanticIssues(`version: "0.0.14"
name: Inline shape
inputs: []
outputs: []
analyses:
  child:
    inputs: []
`, ["MISSING_SUB_FIELD"]);
  });

  it("rejects path mixed with inline fields before replacing the stub", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Path exclusivity
inputs: []
outputs: []
analyses:
  child:
    path: packages/child
    description: Must come from the child file
`);
    await writeAnalysis(`id: child
version: "0.0.14"
name: Child
inputs: []
outputs: []
`, join(root, "packages", "child"));

    const result = await validateAnalysis(reader());
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "PATH_FIELD_CONFLICT",
        file: "astra.yaml",
        path: "analyses.child",
      }),
    ]));
    expect(result.issues.some((issue) => issue.code.startsWith("SCHEMA_"))).toBe(false);
  });

  it("rejects duplicate input and output IDs at nested scopes", async () => {
    await expectSemanticIssues(`version: "0.0.14"
name: Duplicate IDs
inputs: []
outputs: []
analyses:
  child:
    inputs:
      - { id: source, type: data }
      - { id: source, type: data }
    outputs:
      - { id: result, type: data, format: json }
      - { id: result, type: data, format: json }
`, ["DUPLICATE_INPUT", "DUPLICATE_OUTPUT"]);
  });

  it("treats a null decision-map entry as absent", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Null decision
inputs: []
outputs: []
decisions:
  missing: null
`);

    await expect(validateAnalysis(reader())).resolves.toEqual({ valid: true, issues: [] });
    const bundle = await resolveAnalysis(reader());
    expect(bundle.document.analysis.decisions).toEqual([]);
  });

  it("requires defaults to name a declared option", async () => {
    await expectSemanticIssues(`version: "0.0.14"
name: Invalid default
inputs: []
outputs: []
decisions:
  mode:
    label: Mode
    default: missing
    options:
      present: { label: Present }
`, ["INVALID_DEFAULT"]);
  });

  it.each([
    {
      name: "malformed condition",
      when: "mode",
    },
    {
      name: "unknown decision",
      when: "ghost.on",
    },
    {
      name: "unknown option",
      when: "mode.missing",
    },
    {
      name: "self reference",
      when: "conditional.on",
    },
  ])("rejects a decision $name", async ({ when }) => {
    await expectSemanticIssues(`version: "0.0.14"
name: Decision condition
inputs: []
outputs: []
decisions:
  mode:
    label: Mode
    default: on
    options:
      on: { label: On }
  conditional:
    label: Conditional
    default: on
    when: [${when}]
    options:
      on: { label: On }
`, ["INVALID_WHEN_REF"]);
  });

  it("validates output conditions with the same static linker", async () => {
    await expectSemanticIssues(`version: "0.0.14"
name: Output condition
inputs: []
outputs:
  - id: result
    type: data
    format: json
    when: [ghost.on]
`, ["INVALID_WHEN_REF"]);
  });

  it("leaves mutually conditioned defaults inactive without recursive evaluation", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Mutual conditions
inputs: []
outputs: []
decisions:
  first:
    label: First
    default: on
    when: [second.on]
    options:
      on: { label: On }
  second:
    label: Second
    default: on
    when: [first.on]
    options:
      on: { label: On }
`);

    await expect(validateAnalysis(reader())).resolves.toEqual({ valid: true, issues: [] });
    await expect(resolveAnalysis(reader())).resolves.toMatchObject({
      document: {
        analysis: {
          decisions: [
            expect.objectContaining({ id: "first", active: false }),
            expect.objectContaining({ id: "second", active: false }),
          ],
        },
      },
    });
  });

  it("does not apply inactive defaults to constraints or output conditions", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Inactive defaults
inputs: []
decisions:
  mode:
    label: Mode
    default: off
    options:
      on: { label: On }
      off: { label: Off }
  detail:
    label: Detail
    default: full
    when: [mode.on]
    options:
      full:
        label: Full
        requires: [mode.on]
outputs:
  - id: result
    type: data
    format: json
    when: [detail.full]
`);

    await expect(validateAnalysis(reader())).resolves.toEqual({ valid: true, issues: [] });
    const bundle = await resolveAnalysis(reader());
    expect(bundle.document.analysis.decisions[1]).toMatchObject({
      id: "detail",
      active: false,
    });
    expect(bundle.document.analysis.decisions[1]).not.toHaveProperty("selectedOptionId");
    expect(bundle.document.analysis.outputs[0]).toMatchObject({ id: "result", active: false });
  });

  it("settles acyclic negated defaults without retaining stale selections", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Negated default chain
inputs: []
decisions:
  mode:
    label: Mode
    default: on
    options:
      on: { label: On }
  detail:
    label: Detail
    default: full
    when: [~derived.on]
    options:
      full: { label: Full }
  derived:
    label: Derived
    default: on
    when: [mode.on]
    options:
      on: { label: On }
outputs:
  - id: result
    type: data
    format: json
    when: [detail.full]
`);

    await expect(validateAnalysis(reader())).resolves.toEqual({ valid: true, issues: [] });
    const bundle = await resolveAnalysis(reader());
    expect(bundle.document.analysis.decisions[1]).toMatchObject({
      id: "detail",
      active: false,
    });
    expect(bundle.document.analysis.decisions[1]).not.toHaveProperty("selectedOptionId");
    expect(bundle.document.analysis.outputs[0]).toMatchObject({ id: "result", active: false });
  });

  it("rejects default conditions that oscillate instead of settling", async () => {
    const result = await expectSemanticIssues(`version: "0.0.14"
name: Unstable defaults
inputs: []
outputs: []
decisions:
  first:
    label: First
    default: on
    when: [~second.on]
    options:
      on: { label: On }
  second:
    label: Second
    default: on
    when: [first.on]
    options:
      on: { label: On }
`, ["UNSTABLE_DEFAULT_SELECTIONS"]);
    expect(issueCodes(result)).toEqual(["UNSTABLE_DEFAULT_SELECTIONS"]);
  });

  it("does not resolve inherited Object prototype names as authored IDs", async () => {
    await expectSemanticIssues(`version: "0.0.14"
name: Own ID lookup
inputs: []
prior_insights: {}
decisions:
  mode:
    label: Mode
    default: constructor
    options:
      on:
        label: On
        insights: [constructor]
outputs:
  - id: result
    type: data
    format: json
    decisions: [constructor]
`, ["INVALID_DEFAULT", "INVALID_INSIGHT_REF", "INVALID_OUTPUT_DECISION"]);
  });

  it("keeps option insight references node-local", async () => {
    await expectSemanticIssues(`version: "0.0.14"
name: Insight scope
inputs: []
outputs: []
prior_insights:
  precedent:
    claim: Root-owned evidence.
    created_at: "2026-01-01T00:00:00Z"
    evidence:
      - { id: source, doi: 10.1234/example }
analyses:
  child:
    inputs: []
    outputs: []
    decisions:
      method:
        label: Method
        default: published
        options:
          published:
            label: Published
            insights: [precedent]
`, ["INVALID_INSIGHT_REF"]);
  });

  it("accepts an option insight declared in the same child scope", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Local insight
inputs: []
outputs: []
analyses:
  child:
    inputs: []
    outputs: []
    prior_insights:
      precedent:
        claim: Child-owned evidence.
        created_at: "2026-01-01T00:00:00Z"
        evidence:
          - { id: source, doi: 10.1234/example }
    decisions:
      method:
        label: Method
        default: published
        options:
          published:
            label: Published
            insights: [precedent]
`);

    await expect(validateAnalysis(reader())).resolves.toEqual({ valid: true, issues: [] });
  });

  it("resolves explicit option insight paths against ancestor scopes", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Ancestor insight
inputs: []
outputs: []
prior_insights:
  precedent:
    claim: Root-owned evidence.
    created_at: "2026-01-01T00:00:00Z"
    evidence:
      - { id: source, doi: 10.1234/example }
analyses:
  child:
    inputs: []
    outputs: []
    decisions:
      method:
        label: Method
        default: published
        options:
          published:
            label: Published
            insights: [../precedent]
`);

    await expect(validateAnalysis(reader())).resolves.toEqual({ valid: true, issues: [] });
    const bundle = await resolveAnalysis(reader());
    expect(
      bundle.document.analysis.analyses[0]!.decisions[0]!.options[0]!.resolvedInsightPaths,
    ).toEqual(["prior_insights.precedent"]);
  });

  it.each([
    {
      name: "malformed constraint",
      constraint: "support",
      code: "INVALID_CONSTRAINT_FORMAT",
    },
    {
      name: "unknown decision",
      constraint: "ghost.on",
      code: "INVALID_CONSTRAINT_REF",
    },
    {
      name: "unknown option",
      constraint: "support.missing",
      code: "INVALID_CONSTRAINT_REF",
    },
  ])("rejects a $name even when its option is not selected", async ({ constraint, code }) => {
    await expectSemanticIssues(`version: "0.0.14"
name: Static constraints
inputs: []
outputs: []
decisions:
  mode:
    label: Mode
    default: safe
    options:
      safe: { label: Safe }
      unchecked:
        label: Unchecked
        requires: [${constraint}]
  support:
    label: Support
    default: on
    options:
      on: { label: On }
`, [code]);
  });

  it.each([
    {
      name: "excluded option without a reason",
      option: "{ label: Retired, excluded: true }",
      defaultOption: "active",
      code: "MISSING_EXCLUDED_REASON",
    },
    {
      name: "reason on an included option",
      option: "{ label: Retired, excluded_reason: Not used }",
      defaultOption: "active",
      code: "ORPHAN_EXCLUDED_REASON",
    },
    {
      name: "excluded default",
      option: "{ label: Retired, excluded: true, excluded_reason: Not used }",
      defaultOption: "retired",
      code: "EXCLUDED_DEFAULT",
    },
  ])("rejects an $name", async ({ option, defaultOption, code }) => {
    await expectSemanticIssues(`version: "0.0.14"
name: Exclusion metadata
inputs: []
outputs: []
decisions:
  mode:
    label: Mode
    default: ${defaultOption}
    options:
      active: { label: Active }
      retired: ${option}
`, [code]);
  });

  it("requires artifact evidence to name a same-scope output", async () => {
    await expectSemanticIssues(`version: "0.0.14"
name: Artifact evidence
inputs: []
outputs: []
findings:
  conclusion:
    claim: The result is conclusive.
    created_at: "2026-01-01T00:00:00Z"
    evidence:
      - { id: result, artifact: missing }
`, ["INVALID_ARTIFACT_REF"]);
  });

  it("does not treat an empty artifact evidence reference as absent", async () => {
    await expectSemanticIssues(`version: "0.0.14"
name: Empty artifact evidence
inputs: []
outputs: []
findings:
  conclusion:
    claim: The result is conclusive.
    created_at: "2026-01-01T00:00:00Z"
    evidence:
      - { id: result, artifact: "" }
`, ["INVALID_ARTIFACT_REF"]);
  });
});

describe("alias and output dependency rules", () => {
  it("rejects missing input, output, and decision alias targets", async () => {
    await expectSemanticIssues(`version: "0.0.14"
name: Alias targets
inputs: []
outputs:
  - { id: exported, from: child.missing }
decisions:
  root_mode:
    label: Root mode
    default: on
    options:
      on: { label: On }
analyses:
  child:
    inputs:
      - { id: inherited, from: ../missing }
    outputs: []
    decisions:
      inherited_mode:
        from: ../missing
`, ["INVALID_FROM", "INVALID_OUTPUT_FROM", "INVALID_DECISION_FROM"]);
  });

  it("accepts a qualified immediate-child output as an output input", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Child dependency
inputs: []
outputs:
  - id: report
    type: report
    format: md
    inputs: [child.result]
analyses:
  child:
    inputs: []
    outputs:
      - { id: result, type: data, format: json }
`);

    await expect(validateAnalysis(reader())).resolves.toEqual({ valid: true, issues: [] });
  });

  it("rejects unknown output inputs and decisions with canonical codes", async () => {
    await expectSemanticIssues(`version: "0.0.14"
name: Output references
inputs: []
outputs:
  - id: result
    type: data
    format: json
    inputs: [missing]
    decisions: [ghost]
`, ["INVALID_OUTPUT_INPUT", "INVALID_OUTPUT_DECISION"]);
  });

  it.each([
    {
      name: "unbalanced braces",
      command: "run {output",
      code: "INVALID_COMMAND_TEMPLATE",
    },
    {
      name: "unknown placeholder",
      command: "run {parameters.mode}",
      code: "INVALID_COMMAND_TEMPLATE",
    },
    {
      name: "undeclared input",
      command: "run {inputs.missing}",
      code: "UNDECLARED_TEMPLATE_REF",
    },
  ])("rejects recipe templates with $name", async ({ command, code }) => {
    await expectSemanticIssues(`version: "0.0.14"
name: Command template
inputs: []
outputs:
  - id: result
    type: data
    format: json
    recipe:
      command: '${command}'
`, [code]);
  });

  it("detects sibling output dependency cycles", async () => {
    await expectSemanticIssues(`version: "0.0.14"
name: Output cycle
inputs: []
outputs:
  - { id: first, type: data, format: json, inputs: [second] }
  - { id: second, type: data, format: json, inputs: [first] }
`, ["OUTPUT_CYCLE"]);
  });

  it("uses sibling-output precedence when an input shares its ID", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Shared artifact ID
inputs:
  - { id: data, type: data }
outputs:
  - { id: data, type: data, format: csv }
  - { id: report, type: report, format: md, inputs: [data] }
`);

    const bundle = await resolveAnalysis(reader());
    expect(bundle.document.analysis.outputs[1]!.provenance.inputPaths).toEqual([
      "outputs.data",
    ]);
  });

  it("detects a self-cycle when a sibling output shadows an input ID", async () => {
    await expectSemanticIssues(`version: "0.0.14"
name: Shadowed self-cycle
inputs:
  - { id: data, type: data }
outputs:
  - { id: data, type: data, format: csv, inputs: [data] }
`, ["OUTPUT_CYCLE"]);
  });

  it("detects output cycles connected through cross-analysis input aliases", async () => {
    await expectSemanticIssues(`version: "0.0.14"
name: Cross-analysis cycle
inputs: []
outputs: []
analyses:
  first:
    inputs:
      - { id: second_output, from: ../second.result }
    outputs:
      - { id: result, type: data, format: json, inputs: [second_output] }
  second:
    inputs:
      - { id: first_output, from: ../first.result }
    outputs:
      - { id: result, type: data, format: json, inputs: [first_output] }
`, ["OUTPUT_CYCLE"]);
  });

  it("rejects input aliases that ascend and then descend into their own tree", async () => {
    await expectSemanticIssues(`version: "0.0.14"
name: Downward input
inputs: []
outputs: []
analyses:
  child:
    inputs:
      - { id: loop, from: ../child.nested.result }
    outputs: []
    analyses:
      nested:
        inputs: []
        outputs:
          - { id: result, type: data, format: json }
`, ["INVALID_FROM"]);
  });

  it("resolves option constraints against aliased decisions in scope", async () => {
    await expectSemanticIssues(`version: "0.0.14"
name: Alias constraint scope
inputs: []
outputs: []
decisions:
  support:
    label: Support
    default: off
    options:
      on: { label: On }
      off: { label: Off }
analyses:
  child:
    inputs: []
    outputs: []
    decisions:
      inherited_support:
        from: ../support
      method:
        label: Method
        default: constrained
        options:
          constrained:
            label: Constrained
            requires: [inherited_support.on]
`, ["MISSING_REQUIRED_OPTION"]);
  });
});

describe("universe compiler rules", () => {
  const ANALYSIS_WITH_CHOICES = `version: "0.0.14"
name: Universe rules
inputs: []
outputs: []
decisions:
  mode:
    label: Mode
    default: standard
    options:
      standard: { label: Standard }
      constrained:
        label: Constrained
        incompatible_with: [support.on]
        requires: [support.off]
      retired:
        label: Retired
        excluded: true
        excluded_reason: Retired from use
  support:
    label: Support
    default: on
    options:
      on: { label: On }
      off: { label: Off }
  detail:
    label: Detail
    default: full
    when: [mode.standard]
    options:
      full: { label: Full }
analyses:
  child:
    inputs: []
    outputs: []
    decisions:
      inherited:
        from: ../mode
`;

  async function validateUniverse(yaml: string): Promise<AnalysisValidationResult> {
    await writeAnalysis(ANALYSIS_WITH_CHOICES);
    await writeUniverse("test", yaml);
    const result = await validateAnalysis(reader());
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code.startsWith("SCHEMA_"))).toBe(false);
    return result;
  }

  it("evaluates referenced child universes with their parent selection context", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Parent-aware child universe
inputs: []
outputs: []
decisions:
  feature:
    label: Feature
    default: "off"
    options:
      "off": { label: Off }
      "on": { label: On }
analyses:
  child:
    path: packages/child
`);
    const childRoot = join(root, "packages", "child");
    await writeAnalysis(`id: child
version: "0.0.14"
name: Child
inputs: []
outputs: []
decisions:
  inherited_feature:
    from: ../feature
  gated:
    label: Gated
    default: enabled
    when: [inherited_feature.on]
    options:
      enabled:
        label: Enabled
        requires: [inherited_feature.on]
`, childRoot);
    await writeUniverse("configured", `id: configured
decisions:
  feature: "on"
analyses:
  child:
    universe: enabled
`);
    await writeUniverse("enabled", `id: enabled
decisions:
  gated: enabled
`, childRoot);
    await writeUniverse("dormant", `id: dormant
decisions:
  gated: enabled
`, childRoot);

    await expect(validateAnalysis(reader())).resolves.toEqual({ valid: true, issues: [] });
    const bundle = await resolveAnalysis(reader());
    expect(bundle.document.analysis.decisions).toEqual([
      expect.objectContaining({ id: "feature", selectedOptionId: "on" }),
    ]);
    expect(bundle.document.analysis.analyses[0]?.decisions).toEqual([
      expect.objectContaining({
        id: "inherited_feature",
        selectedOptionId: "on",
        active: true,
      }),
      expect.objectContaining({ id: "gated", selectedOptionId: "enabled", active: true }),
    ]);

    // A nested universe without an ancestor configuration cannot be evaluated,
    // but it must still be parsed and checked against the Universe schema.
    await writeUniverse("dormant", "id: dormant\ndecisions: []\n", childRoot);
    const structurallyInvalid = await validateAnalysis(reader());
    expect(structurallyInvalid.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "SCHEMA_TYPE",
        file: "packages/child/universes/dormant.yaml",
        path: "decisions",
      }),
    ]));
  });

  it.each([
    {
      name: "unknown decision",
      decisions: "mode: standard\n  support: on\n  detail: full\n  ghost: on",
      code: "UNKNOWN_DECISION",
    },
    {
      name: "unknown option",
      decisions: "mode: missing\n  support: on",
      code: "UNKNOWN_OPTION",
    },
    {
      name: "excluded option",
      decisions: "mode: retired\n  support: on",
      code: "EXCLUDED_OPTION_SELECTED",
    },
    {
      name: "inactive decision",
      decisions: "mode: constrained\n  support: off\n  detail: full",
      code: "INACTIVE_DECISION",
    },
    {
      name: "missing active decision",
      decisions: "mode: standard\n  support: on",
      code: "MISSING_DECISION_SELECTION",
    },
    {
      name: "incompatible selected options",
      decisions: "mode: constrained\n  support: on",
      code: "INCOMPATIBLE_OPTIONS",
    },
    {
      name: "missing required selected option",
      decisions: "mode: constrained\n  support: on",
      code: "MISSING_REQUIRED_OPTION",
    },
  ])("rejects an $name", async ({ decisions, code }) => {
    const result = await validateUniverse(`id: test
decisions:
  ${decisions}
analyses:
  child:
    decisions: {}
`);
    expect(issueCodes(result)).toContain(code);
  });

  it("rejects selecting a decision alias in a child universe node", async () => {
    const result = await validateUniverse(`id: test
decisions:
  mode: standard
  support: on
  detail: full
analyses:
  child:
    decisions:
      inherited: standard
`);
    expect(issueCodes(result)).toContain("FROM_DECISION_IN_UNIVERSE");
  });

  it("rejects unknown analysis nodes in a universe", async () => {
    const result = await validateUniverse(`id: test
decisions:
  mode: standard
  support: on
  detail: full
analyses:
  child:
    decisions: {}
  ghost:
    decisions: {}
`);
    expect(issueCodes(result)).toContain("UNKNOWN_ANALYSIS");
  });

  it("reports nested selection issues at the universe file's authored path", async () => {
    const result = await validateUniverse(`id: test
decisions:
  mode: standard
  support: on
  detail: full
analyses:
  child:
    decisions:
      ghost: on
`);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "UNKNOWN_DECISION",
        file: "universes/test.yaml",
        path: "analyses.child.decisions.ghost",
      }),
    ]));
  });
});

describe("structural and project-loading coverage", () => {
  it("returns a lexical Analysis.path escape as authored invalidity", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Escaping child
inputs: []
outputs: []
analyses:
  child:
    path: ../outside
`);

    const result = await validateAnalysis(reader());
    expect(result).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({
        code: "ANALYSIS_PATH_ESCAPE",
        file: "astra.yaml",
        path: "analyses.child.path",
      })],
    });
  });

  it("does not stat deterministic result paths during validation", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Validation does not bind artifacts
inputs: []
outputs:
  - { id: result, type: data, format: json }
`);
    const delegate = reader();
    const stats: string[] = [];
    const trackingReader: ProjectReader = {
      readText: (path) => delegate.readText(path),
      readDirectory: (path) => delegate.readDirectory(path),
      async stat(path) {
        stats.push(path);
        return delegate.stat(path);
      },
    };

    await expect(validateAnalysis(trackingReader)).resolves.toEqual({ valid: true, issues: [] });
    expect(stats.some((path) => path === "results" || path.startsWith("results/"))).toBe(false);
  });

  it("rejects a non-directory universes entry as authored invalidity", async () => {
    await writeAnalysis(VALID_ANALYSIS);
    await writeFile(join(root, "universes"), "not a directory");

    const result = await validateAnalysis(reader());
    expect(issueCodes(result)).toContain("INVALID_UNIVERSES_DIRECTORY");
  });

  it("structurally validates every path-backed astra.yaml", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Root
inputs: []
outputs: []
analyses:
  child:
    path: packages/child
`);
    await writeAnalysis(`id: child
version: "0.0.14"
name: Child
inputs: []
outputs:
  - { id: result, type: impossible }
`, join(root, "packages", "child"));

    const result = await validateAnalysis(reader());
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_ENUM", file: "packages/child/astra.yaml" }),
    ]));
  });

  it("structurally validates every universe document", async () => {
    await writeAnalysis(VALID_ANALYSIS);
    await writeUniverse("INVALID", "id: INVALID\ndecisions: {}\n");

    const result = await validateAnalysis(reader());
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_PATTERN", file: "universes/INVALID.yaml" }),
    ]));
  });

  it("validates all universe files, including unselected files", async () => {
    await writeAnalysis(`version: "0.0.14"
name: All universes
inputs: []
outputs: []
decisions:
  mode:
    label: Mode
    default: on
    options:
      on: { label: On }
`);
    await writeUniverse("good", "id: good\ndecisions:\n  mode: on\n");
    await writeUniverse("invalid", "id: invalid\ndecisions:\n  mode: missing\n");

    const result = await validateAnalysis(reader());
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNKNOWN_OPTION", file: "universes/invalid.yaml" }),
    ]));
  });

  it("reports malformed universe YAML as authored invalidity", async () => {
    await writeAnalysis(VALID_ANALYSIS);
    await writeUniverse("broken", "key: [unclosed\n");

    const result = await validateAnalysis(reader());
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_YAML", file: "universes/broken.yaml" }),
    ]));
  });

  it("checks map-key/id agreement in analyses and universes", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Map keys
inputs: []
outputs: []
decisions:
  mode:
    id: other
    label: Mode
    default: on
    options:
      on: { label: On }
`);

    const result = await validateAnalysis(reader());
    expect(issueCodes(result)).toContain("MAP_KEY_ID_MISMATCH");
  });

  it("requires universe IDs to match filenames", async () => {
    await writeAnalysis(VALID_ANALYSIS);
    await writeUniverse("filename", "id: declared\ndecisions: {}\n");

    const result = await validateAnalysis(reader());
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "UNIVERSE_FILENAME_MISMATCH",
        file: "universes/filename.yaml",
        path: "id",
      }),
    ]));
  });

  it("rejects duplicate universe stems across yaml and yml", async () => {
    await writeAnalysis(VALID_ANALYSIS);
    await writeUniverse("same", "id: same\ndecisions: {}\n", root, "yaml");
    await writeUniverse("same", "id: same\ndecisions: {}\n", root, "yml");

    const result = await validateAnalysis(reader());
    expect(issueCodes(result)).toContain("DUPLICATE_UNIVERSE_ID");
  });

  it("reports recursive Analysis.path cycles", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Cycle
inputs: []
outputs: []
analyses:
  self:
    path: .
`);

    const result = await validateAnalysis(reader());
    expect(issueCodes(result)).toContain("ANALYSIS_PATH_CYCLE");
  });

  it("rejects named-universe conflicts and treats null as absent", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Root
inputs: []
outputs: []
analyses:
  child:
    path: packages/child
`);
    const childRoot = join(root, "packages", "child");
    await writeAnalysis(`id: child
version: "0.0.14"
name: Child
inputs: []
outputs: []
`, childRoot);
    await writeUniverse("alternate", "id: alternate\ndecisions: {}\n", childRoot);
    await writeUniverse("conflict", `id: conflict
decisions: {}
analyses:
  child:
    universe: alternate
    decisions: {}
`);
    await writeUniverse("null_ref", `id: null_ref
decisions: {}
analyses:
  child:
    universe: null
    decisions: {}
  unused: null
`);
    await writeUniverse("nullable_conflict_fields", `id: nullable_conflict_fields
decisions: {}
analyses:
  child:
    universe: alternate
    decisions: null
    analyses: null
`);

    const result = await validateAnalysis(reader());
    expect(issueCodes(result)).toContain("UNIVERSE_REFERENCE_CONFLICT");
    expect(result.issues.filter((issue) => issue.file === "universes/null_ref.yaml")).toEqual([]);
    expect(
      result.issues.filter((issue) => issue.file === "universes/nullable_conflict_fields.yaml"),
    ).toEqual([]);
  });

  it("treats a null analysis path as an inline analysis", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Nullable path
inputs: []
outputs: []
analyses:
  child:
    path: null
    description: null
    inputs: []
    outputs: []
`);

    await expect(validateAnalysis(reader())).resolves.toEqual({ valid: true, issues: [] });
    const bundle = await resolveAnalysis(reader());
    expect(bundle.document.analysis.analyses[0]).toMatchObject({
      id: "child",
      canonicalPath: "child",
    });
    expect(bundle.document.analysis.analyses[0]).not.toHaveProperty("path");
    expect(bundle.document.analysis.analyses[0]).not.toHaveProperty("description");
  });

  it("returns unsupported or missing named universes as authored invalidity", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Inline universe
inputs: []
outputs: []
analyses:
  child:
    inputs: []
    outputs: []
`);
    await writeUniverse("inline", `id: inline
decisions: {}
analyses:
  child:
    universe: alternate
`);
    const inline = await validateAnalysis(reader());
    expect(issueCodes(inline)).toContain("UNSUPPORTED_INLINE_UNIVERSE_REFERENCE");
    try {
      await resolveAnalysis(reader());
      throw new Error("expected resolveAnalysis to reject");
    } catch (error) {
      expect(issuesFrom(error)).toEqual(inline.issues);
    }

    await rm(join(root, "universes"), { recursive: true, force: true });
    await writeAnalysis(`version: "0.0.14"
name: Missing named universe
inputs: []
outputs: []
analyses:
  child:
    path: packages/child
`);
    await writeAnalysis(`id: child
version: "0.0.14"
name: Child
inputs: []
outputs: []
`, join(root, "packages", "child"));
    await writeUniverse("root", `id: root
decisions: {}
analyses:
  child:
    universe: absent
`);
    const missing = await validateAnalysis(reader());
    expect(issueCodes(missing)).toContain("UNIVERSE_NOT_FOUND");
    try {
      await resolveAnalysis(reader());
      throw new Error("expected resolveAnalysis to reject");
    } catch (error) {
      expect(issuesFrom(error)).toEqual(missing.issues);
    }
  });

  it("detects deterministic artifact-path collisions without reading results", async () => {
    await writeAnalysis(`version: "0.0.14"
name: Collision
inputs: []
outputs:
  - { id: child, type: data, format: result.csv }
analyses:
  child:
    inputs: []
    outputs:
      - { id: result, type: data, format: csv }
`);

    const result = await validateAnalysis(reader());
    expect(issueCodes(result)).toContain("DUPLICATE_ARTIFACT_PATH");
  });
});
