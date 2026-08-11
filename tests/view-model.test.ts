import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
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

  it("reads the graph organization from .astra/ only", async () => {
    await writeFile(join(root, "astra.yaml"), ASTRA_YAML);
    await mkdir(join(root, ".astra"));
    const organization =
      "schema_version: graph-organization.v1\nsource:\n  entrypoint: astra.yaml\n  organization_input_digest: abc\ngroups: []\n";
    await writeFile(join(root, ".astra", "astra.graph.yaml"), organization);

    const primary = await buildProjectViewModel(createNodeFileAccess(root));
    expect(primary.graphOrganization).toMatchObject({
      schema_version: "graph-organization.v1",
    });
    expect(primary.dependencies.organization).toEqual([".astra/astra.graph.yaml"]);

    await rm(join(root, ".astra"), { recursive: true });
    await writeFile(join(root, "astra.graph.yaml"), organization);
    const rootSidecar = await buildProjectViewModel(createNodeFileAccess(root));
    expect(rootSidecar.graphOrganization).toBeUndefined();
    expect(rootSidecar.dependencies.organization).toEqual([]);
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
});
