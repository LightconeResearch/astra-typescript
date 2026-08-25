import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildProjectViewModel,
  createProjectViewModelIndex,
  resolveProjectRecord,
  validateProjectViewModel,
  type DecisionRecordView,
  type OutputRecordView,
} from "../src/index.js";
import { createNodeFileAccess } from "../src/view-model/node.js";

const ASTRA_YAML = `
version: "1.0"
name: Projector example
inputs:
  - id: catalog
    type: data
    description: Source catalog.
decisions:
  estimator:
    label: Correlation estimator
    default: landy_szalay
    options:
      landy_szalay:
        label: Landy-Szalay (fiducial)
      natural:
        label: Natural
outputs:
  - id: headline
    type: figure
    description: Headline figure.
    inputs: [catalog]
    decisions: [estimator]
`;

// A re-export at the root standing for a child's output. The alias declares
// no `format` — the schema forbids it — so the projection has to supply the
// child's.
const NESTED_YAML = `
version: "1.0"
name: Nested example
inputs:
  - id: catalog
    type: data
    description: Source catalog.
outputs:
  - id: headline
    from: stage.plot
analyses:
  stage:
    id: stage
    outputs:
      - id: plot
        type: figure
        format: svg
        description: Stage figure.
`;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "astra-view-model-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("buildProjectViewModel", () => {
  it("emits a canonical project-view-model.v1 document", async () => {
    await writeFile(join(root, "astra.yaml"), ASTRA_YAML);
    await mkdir(join(root, "universes"));
    await writeFile(
      join(root, "universes", "baseline.yaml"),
      "id: baseline\ndecisions:\n  estimator: natural\n",
    );

    const bundle = await buildProjectViewModel(createNodeFileAccess(root));
    const model = bundle.model;

    expect(model.schemaVersion).toBe("project-view-model.v1");
    expect(model.revision.analysis).toBe(bundle.revisions.analysis);
    expect(model.scopes.map((scope) => scope.id)).toEqual(["root"]);
    expect(model.scopes[0]!.canonicalPath).toBe("root");
    expect(model.selection.universeId).toBe("baseline");
    expect(model.selection.availableUniverses).toEqual(["baseline"]);

    const byPath = new Map(model.records.map((record) => [record.canonicalPath, record]));
    const output = byPath.get("outputs.headline") as OutputRecordView;
    expect(output.id).toBe("root:output:headline");
    expect(output.outputType).toBe("figure");
    expect(
      output.relations
        .map((relation) => [relation.kind, relation.targetRecordId])
        .sort(),
    ).toEqual([
      ["depends_on", "root:input:catalog"],
      ["parameterized_by", "root:decision:estimator"],
    ]);
    expect(output.provenance.inputs[0]!.recordId).toBe("root:input:catalog");

    const decision = byPath.get("decisions.estimator") as DecisionRecordView;
    expect(decision.selectedOptionId).toBe("natural");
    expect(decision.options.map((option) => option.id)).toEqual([
      "landy_szalay",
      "natural",
    ]);
    expect(decision.options[1]!.selected).toBe(true);
    expect(model.selection.decisions).toEqual({ "root:decision:estimator": "natural" });

    expect(validateProjectViewModel(model)).toEqual([]);
  });

  it("binds materialized artifacts as enriched resources", async () => {
    await writeFile(join(root, "astra.yaml"), ASTRA_YAML);
    await mkdir(join(root, "results", "default", "headline"), { recursive: true });
    await writeFile(
      join(root, "results", "default", "headline", "headline.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    const bundle = await buildProjectViewModel(createNodeFileAccess(root));

    expect(bundle.artifacts).toHaveLength(1);
    const binding = bundle.artifacts[0]!;
    expect(binding.id).toBe("resource:root:output:headline");
    expect(binding.path).toBe("results/default/headline/headline.png");
    expect(binding.mediaType).toBe("image/png");

    const resource = bundle.model.resources[0]!;
    expect(resource.id).toBe(binding.id);
    expect(resource.kind).toBe("figure");
    expect(resource.fileName).toBe("headline.png");
    expect(resource.byteSize).toBe(4);
    expect(resource.revision).toBe(binding.revision);

    const output = bundle.model.records.find(
      (record) => record.canonicalPath === "outputs.headline",
    ) as OutputRecordView;
    expect(output.resourceIds).toEqual([binding.id]);
    expect(
      bundle.model.diagnostics.some(
        (diagnostic) => diagnostic.code === "missing_expected_result",
      ),
    ).toBe(false);
  });

  it("does not guess artifacts outside the canonical result directory", async () => {
    await writeFile(join(root, "astra.yaml"), ASTRA_YAML);
    await mkdir(join(root, "outputs", "default"), { recursive: true });
    await writeFile(join(root, "outputs", "default", "headline.png"), "legacy");

    const bundle = await buildProjectViewModel(createNodeFileAccess(root));
    const output = bundle.model.records.find(
      (record) => record.canonicalPath === "outputs.headline",
    ) as OutputRecordView;

    expect(output.resourceIds).toEqual([]);
    expect(bundle.artifacts).toEqual([]);
    expect(bundle.model.diagnostics).toContainEqual({
      severity: "info",
      code: "missing_expected_result",
      message:
        "No materialized result was found. Expected it at results/default/headline/. "
        + "Place or materialize the result there, then refresh.",
      canonicalPath: "outputs.headline",
    });
  });

  it("does not require a materialized file for a declared metric value", async () => {
    await writeFile(
      join(root, "astra.yaml"),
      'version: "1.0"\nname: Metrics\noutputs:\n  - id: score\n    type: metric\n    metric:\n      value: 0.97\n',
    );

    const bundle = await buildProjectViewModel(createNodeFileAccess(root));

    expect(
      bundle.model.diagnostics.some(
        (diagnostic) => diagnostic.code === "missing_expected_result",
      ),
    ).toBe(false);
  });

  it("keeps unresolved references as diagnostics, not dangling edges", async () => {
    await writeFile(
      join(root, "astra.yaml"),
      'version: "1.0"\nname: Unresolved\noutputs:\n  - id: headline\n    type: figure\n    inputs: [missing_catalog]\n',
    );

    const bundle = await buildProjectViewModel(createNodeFileAccess(root));
    const output = bundle.model.records.find(
      (record) => record.canonicalPath === "outputs.headline",
    ) as OutputRecordView;

    expect(output.relations).toEqual([]);
    expect(output.provenance.inputs[0]).toEqual({
      reference: "missing_catalog",
      direct: true,
    });
    expect(
      bundle.model.diagnostics.some(
        (diagnostic) => diagnostic.code === "unresolved_relation",
      ),
    ).toBe(true);
  });

  it("rejects retired schema versions and removed fields", async () => {
    await writeFile(
      join(root, "astra.yaml"),
      'version: "0.0.13"\nname: Retired schema\n',
    );
    await expect(
      buildProjectViewModel(createNodeFileAccess(root)),
    ).rejects.toThrow('Unsupported ASTRA version "0.0.13"');

    await writeFile(
      join(root, "astra.yaml"),
      'version: "1.0"\nname: Current schema\nauthors: [Legacy Author]\n',
    );
    await expect(
      buildProjectViewModel(createNodeFileAccess(root)),
    ).rejects.toThrow('Unsupported ASTRA field "authors"');
  });

  it("changes the analysis revision when the spec changes, not when artifacts do", async () => {
    await writeFile(join(root, "astra.yaml"), ASTRA_YAML);
    await mkdir(join(root, "results", "default", "headline"), { recursive: true });
    const artifact = join(root, "results", "default", "headline", "headline.png");
    await writeFile(artifact, "one");

    const before = await buildProjectViewModel(createNodeFileAccess(root));
    await writeFile(artifact, "two!");
    await utimes(artifact, new Date(), new Date(Date.now() + 5_000));
    const after = await buildProjectViewModel(createNodeFileAccess(root));

    expect(after.revisions.analysis).toBe(before.revisions.analysis);
    expect(after.revisions.materialization).not.toBe(before.revisions.materialization);
    expect(after.revision).not.toBe(before.revision);
  });

  it("resolves records through the shared index", async () => {
    await writeFile(join(root, "astra.yaml"), ASTRA_YAML);
    const bundle = await buildProjectViewModel(createNodeFileAccess(root));
    const index = createProjectViewModelIndex(bundle.model);

    expect(resolveProjectRecord(index, "outputs.headline")?.record.id).toBe(
      "root:output:headline",
    );
    expect(
      resolveProjectRecord(index, { id: "estimator", kind: "decision" })?.record.id,
    ).toBe("root:decision:estimator");
  });

  it("prevents file access from escaping the project root", async () => {
    await writeFile(join(root, "astra.yaml"), ASTRA_YAML);
    const access = createNodeFileAccess(root);

    await expect(access.readText("../outside.yaml")).rejects.toThrow(
      "Project path escapes the project root",
    );
    await expect(access.stat(join(root, "astra.yaml"))).rejects.toThrow(
      "Project path must be relative",
    );

    const outside = await mkdtemp(join(tmpdir(), "astra-view-model-outside-"));
    try {
      await symlink(outside, join(root, "escape"));
      await expect(access.listDirectory("escape")).rejects.toThrow(
        "Project path escapes the project root",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("carries the declared output format", async () => {
    await writeFile(
      join(root, "astra.yaml"),
      ASTRA_YAML.replace("    type: figure\n", "    type: figure\n    format: png\n"),
    );

    const bundle = await buildProjectViewModel(createNodeFileAccess(root));
    const byPath = new Map(bundle.model.records.map((r) => [r.canonicalPath, r]));
    expect((byPath.get("outputs.headline") as OutputRecordView).format).toBe("png");
  });

  it("leaves format absent when the spec omits it", async () => {
    await writeFile(join(root, "astra.yaml"), ASTRA_YAML);

    const bundle = await buildProjectViewModel(createNodeFileAccess(root));
    const byPath = new Map(bundle.model.records.map((r) => [r.canonicalPath, r]));
    expect((byPath.get("outputs.headline") as OutputRecordView).format).toBeUndefined();
  });

  it("gives a re-export the format of the output it stands for", async () => {
    await writeFile(join(root, "astra.yaml"), NESTED_YAML);

    const bundle = await buildProjectViewModel(createNodeFileAccess(root));
    const byPath = new Map(bundle.model.records.map((r) => [r.canonicalPath, r]));
    expect((byPath.get("outputs.headline") as OutputRecordView).format).toBe("svg");
    expect((byPath.get("stage.outputs.plot") as OutputRecordView).format).toBe("svg");
  });

  it("uses the declared format to pick the artifact among several files", async () => {
    await writeFile(
      join(root, "astra.yaml"),
      ASTRA_YAML.replace("    type: figure\n", "    type: figure\n    format: pdf\n"),
    );
    const dir = join(root, "results", "default", "headline");
    await mkdir(dir, { recursive: true });
    // Sorts before the real artifact, and would win on `own[0]` alone.
    await writeFile(join(dir, "headline.log"), "run log\n");
    await writeFile(join(dir, "headline.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46]));

    const bundle = await buildProjectViewModel(createNodeFileAccess(root));

    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.artifacts[0]!.path).toBe("results/default/headline/headline.pdf");
  });

  it("picks the artifact by extension when the run named the file itself", async () => {
    await writeFile(
      join(root, "astra.yaml"),
      ASTRA_YAML.replace("    type: figure\n", "    type: figure\n    format: pdf\n"),
    );
    const dir = join(root, "results", "default", "headline");
    await mkdir(dir, { recursive: true });
    // The artifact does not carry the output's id, so only its extension
    // separates it from the log that sorts ahead of it.
    await writeFile(join(dir, "headline.log"), "run log\n");
    await writeFile(join(dir, "figure.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46]));

    const bundle = await buildProjectViewModel(createNodeFileAccess(root));

    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.artifacts[0]!.path).toBe("results/default/headline/figure.pdf");
  });

  it("uses a re-export's inherited format to pick its artifact", async () => {
    // The format the alias reports and the file it binds have to agree: a
    // viewer told `svg` and handed the run log would open the wrong thing.
    await writeFile(join(root, "astra.yaml"), NESTED_YAML);
    const dir = join(root, "results", "default", "headline");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "headline.log"), "run log\n");
    await writeFile(join(dir, "headline.svg"), "<svg></svg>\n");

    const bundle = await buildProjectViewModel(createNodeFileAccess(root));
    const byPath = new Map(bundle.model.records.map((r) => [r.canonicalPath, r]));
    const headline = byPath.get("outputs.headline") as OutputRecordView;

    expect(headline.format).toBe("svg");
    const binding = bundle.artifacts.find((entry) => entry.recordId === headline.id);
    expect(binding?.path).toBe("results/default/headline/headline.svg");
    expect(binding?.mediaType).toBe("image/svg+xml");
  });
});
