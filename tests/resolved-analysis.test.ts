import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AnalysisValidationError,
  indexAnalysis,
  resolveAnalysis,
  ResolveAnalysisError,
  type ProjectReader,
  type ResolvedOutput,
} from "../src/index.js";
import { createNodeProjectReader } from "../src/node.js";

const BASIC_ANALYSIS = `
version: "0.0.14"
name: Resolver example
inputs:
  - id: catalog
    type: data
    description: Source catalog
decisions:
  estimator:
    label: Estimator
    default: natural
    options:
      natural:
        label: Natural
      weighted:
        label: Weighted
outputs:
  - id: headline
    type: figure
    format: png
    inputs: [catalog]
    decisions: [estimator]
`;

const NESTED_ANALYSIS = `
version: "0.0.14"
name: Recursive example
inputs:
  - id: catalog
    type: data
outputs:
  - id: summary
    type: report
    format: md
  - id: headline
    from: stage.plot
decisions:
  method:
    label: Method
    default: robust
    options:
      robust:
        label: Robust
prior_insights:
  precedent:
    claim: Prior work supports this method.
    created_at: "2026-01-01T00:00:00Z"
    evidence:
      - id: cited_work
        doi: 10.1234/example
analyses:
  stage:
    description: Inline stage
    inputs:
      - id: source
        from: ../catalog
    outputs:
      - id: plot
        type: figure
        format: svg
        inputs: [source]
        decisions: [local_method]
        when: [local_method.robust]
    decisions:
      local_method:
        from: ../method
    findings:
      result:
        claim: The plot contains the result.
        created_at: "2026-01-02T00:00:00Z"
        evidence:
          - id: plot_evidence
            artifact: plot
`;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "astra-resolved-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeUniverse(name: string, yaml: string): Promise<void> {
  await mkdir(join(root, "universes"), { recursive: true });
  await writeFile(join(root, "universes", `${name}.yaml`), yaml);
}

function outputAt(outputs: ResolvedOutput[], id: string): ResolvedOutput {
  return outputs.find((output) => output.id === id)!;
}

describe("resolveAnalysis", () => {
  it("accepts an explicitly injected structural schema", async () => {
    await writeFile(join(root, "astra.yaml"), BASIC_ANALYSIS);
    const rejectingSchema = {
      $schema: "https://json-schema.org/draft/2019-09/schema",
      $defs: { Universe: { type: "object" } },
      not: {},
    };

    await expect(resolveAnalysis(createNodeProjectReader(root), {
      schema: rejectingSchema,
    })).rejects.toMatchObject({
      name: "AnalysisValidationError",
      issues: [expect.objectContaining({ code: "SCHEMA_NOT" })],
    });
  });

  it("returns the recursive, serializable resolved document", async () => {
    await writeFile(join(root, "astra.yaml"), NESTED_ANALYSIS);
    await writeUniverse(
      "baseline",
      "id: baseline\ndecisions:\n  method: robust\nanalyses:\n  stage:\n    decisions: {}\n",
    );

    const bundle = await resolveAnalysis(createNodeProjectReader(root));
    const document = bundle.document;

    expect(document.schemaVersion).toBe("astra-resolved-analysis.v1");
    expect(document.analysis.version).toBe("0.0.14");
    expect(document.universe).toEqual({
      universeId: "baseline",
      availableUniverseIds: ["baseline"],
      source: "implicit",
    });
    expect(document.analysis.canonicalPath).toBe("$");
    expect(document.analysis.analyses.map((analysis) => analysis.canonicalPath)).toEqual(["stage"]);

    const stage = document.analysis.analyses[0]!;
    expect(stage.id).toBe("stage");
    expect(stage.inputs[0]).toMatchObject({
      id: "source",
      type: "data",
      kind: "input",
      resolvedFrom: "inputs.catalog",
    });
    expect(stage.decisions[0]).toMatchObject({
      id: "local_method",
      label: "Method",
      selectedOptionId: "robust",
      resolvedFrom: "decisions.method",
    });
    expect(stage.outputs[0]!.provenance).toEqual({
      inputPaths: ["inputs.catalog"],
      decisionPaths: ["decisions.method"],
    });
    expect(stage.outputs[0]!.when).toEqual(["local_method.robust"]);
    expect(stage.findings[0]!.evidence[0]!.resolvedOutputPath).toBe("stage.outputs.plot");

    const alias = outputAt(document.analysis.outputs, "headline");
    expect(alias).toMatchObject({
      type: "figure",
      format: "svg",
      resolvedFrom: "stage.outputs.plot",
      active: true,
    });
    expect(alias).not.toHaveProperty("when");
    expect(alias.provenance).toEqual(stage.outputs[0]!.provenance);
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
  });

  it("stats only deterministic root and inline artifact paths", async () => {
    await writeFile(join(root, "astra.yaml"), NESTED_ANALYSIS);
    await writeUniverse(
      "baseline",
      "id: baseline\ndecisions:\n  method: robust\nanalyses:\n  stage:\n    decisions: {}\n",
    );
    await mkdir(join(root, "results", "baseline"), { recursive: true });
    await writeFile(join(root, "results", "baseline", "summary.md"), "summary");
    await writeFile(join(root, "results", "baseline", "stage.plot.svg"), "<svg/>");
    await mkdir(join(root, "results", "baseline", "headline"), { recursive: true });
    await writeFile(join(root, "results", "baseline", "headline", "legacy.svg"), "legacy");

    const bundle = await resolveAnalysis(createNodeProjectReader(root));
    expect(bundle.bindings.map(({ outputPath, path }) => [outputPath, path])).toEqual([
      ["outputs.summary", "results/baseline/summary.md"],
      ["outputs.headline", "results/baseline/stage.plot.svg"],
      ["stage.outputs.plot", "results/baseline/stage.plot.svg"],
    ]);
    expect(outputAt(bundle.document.analysis.outputs, "summary").artifact).toEqual({ byteSize: 7 });
    expect(outputAt(bundle.document.analysis.outputs, "headline").artifact).toEqual({ byteSize: 6 });
    expect(bundle.document.analysis.analyses[0]!.outputs[0]!.artifact).toEqual({ byteSize: 6 });
  });

  it("emits the specified full cache token and changes it with metadata", async () => {
    await writeFile(join(root, "astra.yaml"), BASIC_ANALYSIS);
    const artifact = join(root, "results", "default", "headline.png");
    await mkdir(join(root, "results", "default"), { recursive: true });
    await writeFile(artifact, "one");
    const reader = createNodeProjectReader(root);
    const before = await resolveAnalysis(reader);
    const beforeBinding = before.bindings[0]!;
    const beforeStat = await reader.stat(beforeBinding.path);
    expect(beforeStat?.type).toBe("file");
    if (beforeStat?.type !== "file") throw new Error("missing test artifact");
    expect(beforeBinding.cacheToken).toBe(
      createHash("sha256")
        .update(`${beforeBinding.path}\0${beforeStat.modifiedAtMs}\0${beforeStat.size}`)
        .digest("hex"),
    );
    expect(beforeBinding.cacheToken).toMatch(/^[0-9a-f]{64}$/);

    await writeFile(artifact, "two!");
    await utimes(artifact, new Date(), new Date(Date.now() + 5_000));
    const after = await resolveAnalysis(reader);
    expect(after.bindings[0]!.cacheToken).not.toBe(beforeBinding.cacheToken);
  });

  it("represents missing and inactive artifacts only by absence", async () => {
    await writeFile(
      join(root, "astra.yaml"),
      BASIC_ANALYSIS.replace("    decisions: [estimator]\n", "    decisions: [estimator]\n    when: [estimator.weighted]\n"),
    );
    const bundle = await resolveAnalysis(createNodeProjectReader(root));
    const output = bundle.document.analysis.outputs[0]!;
    expect(output.active).toBe(false);
    expect(output).not.toHaveProperty("artifact");
    expect(bundle.bindings).toEqual([]);
  });

  it("uses defaults only when no root universe files exist", async () => {
    await writeFile(join(root, "astra.yaml"), BASIC_ANALYSIS);
    const bundle = await resolveAnalysis(createNodeProjectReader(root));
    expect(bundle.document.universe).toEqual({
      universeId: "default",
      availableUniverseIds: [],
      source: "none",
    });
    expect(bundle.document.analysis.decisions[0]!.selectedOptionId).toBe("natural");

    await writeFile(join(root, "astra.yaml"), BASIC_ANALYSIS.replace("    default: natural\n", ""));
    await expect(resolveAnalysis(createNodeProjectReader(root))).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "MISSING_DECISION_SELECTION" }),
      ]),
    });
  });

  it("validates every universe, including unselected files", async () => {
    await writeFile(join(root, "astra.yaml"), BASIC_ANALYSIS);
    await writeUniverse("good", "id: good\ndecisions:\n  estimator: natural\n");
    await writeUniverse("invalid", "id: invalid\ndecisions:\n  estimator: absent\n");

    await expect(
      resolveAnalysis(createNodeProjectReader(root), { universeId: "good" }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "UNKNOWN_OPTION",
          file: "universes/invalid.yaml",
        }),
      ]),
    });
  });

  it("normalizes scalar options and verbose universe selections", async () => {
    await writeFile(
      join(root, "astra.yaml"),
      BASIC_ANALYSIS.replace(
        `      natural:
        label: Natural
      weighted:
        label: Weighted`,
        `      natural: Natural
      weighted: Weighted`,
      ),
    );
    await writeUniverse(
      "weighted",
      `id: weighted
decisions:
  estimator:
    option_id: weighted
`,
    );

    const bundle = await resolveAnalysis(createNodeProjectReader(root));
    expect(bundle.document.analysis.decisions[0]).toMatchObject({
      selectedOptionId: "weighted",
      options: [
        { id: "natural", label: "Natural", resolvedInsightPaths: [] },
        { id: "weighted", label: "Weighted", resolvedInsightPaths: [] },
      ],
    });
  });

  it("reports nested universe issues at their authored YAML paths", async () => {
    await writeFile(join(root, "astra.yaml"), NESTED_ANALYSIS);
    await writeUniverse(
      "invalid",
      `id: invalid
decisions:
  method: robust
analyses:
  stage:
    decisions:
      ghost: absent
`,
    );

    await expect(resolveAnalysis(createNodeProjectReader(root))).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "UNKNOWN_DECISION",
          file: "universes/invalid.yaml",
          path: "analyses.stage.decisions.ghost",
        }),
      ]),
    });
  });

  it("evaluates inherited option constraints only in their defining scope", async () => {
    await writeFile(
      join(root, "astra.yaml"),
      `version: "0.0.14"
name: Alias constraints
inputs: []
outputs: []
decisions:
  mode:
    label: Mode
    default: standard
    options:
      standard:
        label: Standard
        requires: [support.on]
  support:
    label: Support
    default: on
    options:
      on:
        label: On
analyses:
  child:
    inputs: []
    outputs: []
    decisions:
      inherited_mode:
        from: ../mode
`,
    );

    const bundle = await resolveAnalysis(createNodeProjectReader(root));
    expect(bundle.document.analysis.analyses[0]!.decisions[0]).toMatchObject({
      id: "inherited_mode",
      resolvedFrom: "decisions.mode",
      selectedOptionId: "standard",
    });
  });

  it("loads named universes for path-backed analyses and resets result namespaces", async () => {
    await writeFile(
      join(root, "astra.yaml"),
      `version: "0.0.14"
name: Root
inputs: []
outputs:
  - id: exported
    from: child.plot
analyses:
  child:
    path: packages/child
`,
    );
    await writeUniverse(
      "main",
      "id: main\nanalyses:\n  child:\n    universe: alternate\n",
    );
    const childRoot = join(root, "packages", "child");
    await mkdir(join(childRoot, "universes"), { recursive: true });
    await writeFile(
      join(childRoot, "astra.yaml"),
      `id: child
version: "0.0.14"
name: Child
inputs: []
outputs:
  - id: plot
    type: figure
    format: png
    decisions: [style]
decisions:
  style:
    label: Style
    default: plain
    options:
      plain:
        label: Plain
      alternate:
        label: Alternate
analyses:
  detail:
    inputs: []
    outputs:
      - id: table
        type: table
        format: csv
`,
    );
    await writeFile(
      join(childRoot, "universes", "alternate.yaml"),
      "id: alternate\ndecisions:\n  style: alternate\nanalyses:\n  detail:\n    decisions: {}\n",
    );
    await mkdir(join(childRoot, "results", "alternate"), { recursive: true });
    await writeFile(join(childRoot, "results", "alternate", "plot.png"), "png");
    await writeFile(join(childRoot, "results", "alternate", "detail.table.csv"), "csv");

    const bundle = await resolveAnalysis(createNodeProjectReader(root));
    const child = bundle.document.analysis.analyses[0]!;
    expect(child.decisions[0]!.selectedOptionId).toBe("alternate");
    expect(bundle.bindings.map((binding) => binding.path)).toEqual([
      "packages/child/results/alternate/plot.png",
      "packages/child/results/alternate/plot.png",
      "packages/child/results/alternate/detail.table.csv",
    ]);
  });

  it("rejects named-universe references on inline children", async () => {
    await writeFile(join(root, "astra.yaml"), NESTED_ANALYSIS);
    await writeUniverse(
      "baseline",
      "id: baseline\ndecisions:\n  method: robust\nanalyses:\n  stage:\n    universe: alternate\n",
    );
    await expect(resolveAnalysis(createNodeProjectReader(root))).rejects.toMatchObject({
      code: "UNSUPPORTED_INLINE_UNIVERSE_REFERENCE",
    });
  });

  it("treats a null child universe reference as absent", async () => {
    await writeFile(join(root, "astra.yaml"), NESTED_ANALYSIS);
    await writeUniverse(
      "baseline",
      `id: baseline
decisions:
  method: robust
analyses:
  stage:
    universe: null
    decisions: {}
`,
    );

    const bundle = await resolveAnalysis(createNodeProjectReader(root));
    expect(bundle.document.analysis.analyses[0]!.decisions[0]!.selectedOptionId).toBe("robust");
  });

  it("evaluates activity through every alias in a chain", async () => {
    await writeFile(
      join(root, "astra.yaml"),
      `version: "0.0.14"
name: Alias activity chain
inputs: []
outputs:
  - id: exported
    from: stage.forwarded
decisions:
  source:
    label: Source
    default: standard
    options:
      standard: Standard
  activation:
    label: Activation
    default: "off"
    options:
      "off": Off
      "on": On
analyses:
  stage:
    inputs: []
    outputs:
      - id: forwarded
        from: leaf.plot
        when: [activation.on]
    decisions:
      activation:
        from: ../activation
      middle:
        from: ../source
        when: [activation.on]
    analyses:
      leaf:
        inputs: []
        outputs:
          - id: plot
            type: figure
            format: png
            decisions: [inherited]
            when: [inherited.standard]
        decisions:
          inherited:
            from: ../middle
`,
    );
    await mkdir(join(root, "results", "default"), { recursive: true });
    await writeFile(join(root, "results", "default", "stage.leaf.plot.png"), "png");

    const bundle = await resolveAnalysis(createNodeProjectReader(root));
    const stage = bundle.document.analysis.analyses[0]!;
    const leaf = stage.analyses[0]!;
    expect(outputAt(bundle.document.analysis.outputs, "exported")).toMatchObject({
      active: false,
      resolvedFrom: "stage.leaf.outputs.plot",
    });
    expect(outputAt(stage.outputs, "forwarded")).toMatchObject({
      active: false,
      resolvedFrom: "stage.leaf.outputs.plot",
    });
    expect(outputAt(leaf.outputs, "plot").active).toBe(true);
    expect(stage.decisions.find((decision) => decision.id === "middle")).toMatchObject({
      active: false,
      resolvedFrom: "decisions.source",
    });
    expect(leaf.decisions[0]).toMatchObject({
      active: false,
      resolvedFrom: "decisions.source",
    });
    expect(bundle.bindings.map((binding) => binding.outputPath)).toEqual([
      "stage.leaf.outputs.plot",
    ]);
  });

  it("rejects deterministic filename collisions", async () => {
    await writeFile(
      join(root, "astra.yaml"),
      `version: "0.0.14"
name: Collision
inputs: []
outputs:
  - id: child
    type: data
    format: result.csv
analyses:
  child:
    inputs: []
    outputs:
      - id: result
        type: data
        format: csv
`,
    );
    await expect(resolveAnalysis(createNodeProjectReader(root))).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "DUPLICATE_ARTIFACT_PATH" }),
      ]),
    });
  });

  it("rejects invalid projects without returning a partial document", async () => {
    await writeFile(
      join(root, "astra.yaml"),
      BASIC_ANALYSIS.replace("inputs: [catalog]", "inputs: [missing]")
        .replace("format: png", "format: PNG"),
    );
    try {
      await resolveAnalysis(createNodeProjectReader(root));
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AnalysisValidationError);
      const codes = (error as AnalysisValidationError).issues.map((issue) => issue.code);
      expect(codes).toContain("SCHEMA_PATTERN");
      expect(codes).toContain("INVALID_OUTPUT_INPUT");
    }
  });

  it("reports a null decision as a validation issue", async () => {
    await writeFile(
      join(root, "astra.yaml"),
      `version: "0.0.14"
name: Missing decision
inputs: []
outputs: []
decisions:
  missing: null
`,
    );

    await expect(resolveAnalysis(createNodeProjectReader(root))).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "MISSING_DECISION_DEFINITION",
          file: "astra.yaml",
          path: "decisions.missing",
        }),
      ]),
    });
  });

  it("validates required root fields in every path-backed analysis", async () => {
    await writeFile(
      join(root, "astra.yaml"),
      `version: "0.0.14"
name: Root
inputs:
  - id: catalog
    type: data
outputs: []
analyses:
  child:
    path: packages/child
`,
    );
    await mkdir(join(root, "packages", "child"), { recursive: true });
    await writeFile(
      join(root, "packages", "child", "astra.yaml"),
      `id: child
inputs: []
outputs: []
analyses:
  grandchild:
    inputs:
      - id: source
        from: ../../catalog
    outputs: []
`,
    );

    try {
      await resolveAnalysis(createNodeProjectReader(root));
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AnalysisValidationError);
      const issues = (error as AnalysisValidationError).issues;
      expect(issues).toEqual(expect.arrayContaining([
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
      expect(issues).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_FROM" }),
      ]));
    }
  });

  it("keeps distinct validation issues that share a path", async () => {
    await writeFile(
      join(root, "astra.yaml"),
      `version: "0.0.14"
name: Complete errors
inputs: []
outputs:
  - id: result
    type: data
    format: json
    inputs: [missing_a, missing_b]
`,
    );

    try {
      await resolveAnalysis(createNodeProjectReader(root));
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AnalysisValidationError);
      const issues = (error as AnalysisValidationError).issues.filter(
        (issue) => issue.code === "INVALID_OUTPUT_INPUT",
      );
      expect(issues).toHaveLength(2);
      expect(issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
        expect.stringContaining("missing_a"),
        expect.stringContaining("missing_b"),
      ]));
      expect(issues.every((issue) => issue.path === "outputs.result.inputs")).toBe(true);
    }
  });

  it("builds optional indexes from canonical paths", async () => {
    await writeFile(join(root, "astra.yaml"), BASIC_ANALYSIS);
    const bundle = await resolveAnalysis(createNodeProjectReader(root));
    const index = indexAnalysis(bundle.document);
    expect(index.analysisByPath.get("$")).toBe(bundle.document.analysis);
    expect(index.recordByPath.get("outputs.headline")).toBe(bundle.document.analysis.outputs[0]);
  });

  it("does not list result directories", async () => {
    const files = new Map<string, string>([["astra.yaml", BASIC_ANALYSIS]]);
    const listed: string[] = [];
    const reader: ProjectReader = {
      async readText(path) {
        const value = files.get(path);
        if (value === undefined) throw new Error("missing");
        return value;
      },
      async stat(path) {
        if (path === "astra.yaml") return { type: "file", size: 1, modifiedAtMs: 1 };
        return undefined;
      },
      async readDirectory(path) {
        listed.push(path);
        return [];
      },
    };
    await resolveAnalysis(reader);
    expect(listed).toEqual([]);
  });
});

describe("createNodeProjectReader", () => {
  it("enforces normalized, project-rooted paths and symlink containment", async () => {
    await writeFile(join(root, "astra.yaml"), BASIC_ANALYSIS);
    const reader = createNodeProjectReader(root);
    await expect(reader.readText("../outside.yaml")).rejects.toThrow("normalized and relative");
    await expect(reader.stat(join(root, "astra.yaml"))).rejects.toThrow("normalized and relative");

    const outside = await mkdtemp(join(tmpdir(), "astra-reader-outside-"));
    try {
      await symlink(outside, join(root, "escape"));
      await expect(reader.readDirectory("escape")).rejects.toThrow("escapes the project root");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects invalid UTF-8 and maps a loading symlink escape", async () => {
    await writeFile(join(root, "invalid.yaml"), Buffer.from([0xff]));
    await expect(createNodeProjectReader(root).readText("invalid.yaml")).rejects.toThrow();

    const outside = await mkdtemp(join(tmpdir(), "astra-reader-project-escape-"));
    try {
      await writeFile(
        join(root, "astra.yaml"),
        `version: "0.0.14"
name: Escape
inputs: []
outputs: []
analyses:
  child:
    path: linked
`,
      );
      await writeFile(join(outside, "astra.yaml"), BASIC_ANALYSIS);
      await symlink(outside, join(root, "linked"));
      await expect(resolveAnalysis(createNodeProjectReader(root))).rejects.toMatchObject({
        code: "PROJECT_PATH_ESCAPE",
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("distinguishes a missing project from a malformed project", async () => {
    await expect(resolveAnalysis(createNodeProjectReader(root))).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    } satisfies Partial<ResolveAnalysisError>);
    await writeFile(join(root, "astra.yaml"), "- not\n- a mapping\n");
    await expect(resolveAnalysis(createNodeProjectReader(root))).rejects.toMatchObject({
      code: "INVALID_YAML",
    } satisfies Partial<ResolveAnalysisError>);
  });
});
