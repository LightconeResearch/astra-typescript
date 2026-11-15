/** Bind repository documents and all authored addresses, retaining declaration chains. */
import { loadAnalysisDocument } from "./documents.js";
import {
  parseAddress,
  parseReference,
  parseOptionReference,
} from "./grammar.js";
import type { AuthoredAnalysis } from "./documents.js";
import type { SourceProvider, Tree } from "../sources/types.js";
import type { Diagnostic } from "../reports/types.js";
import {
  Stack,
  TAKES,
  type Member,
  type Identity,
  type Element,
  type Kind,
  type Resolution,
  type Declaration,
  type Pointer,
  type Field,
  type Address,
} from "./model.js";

export function elements(
  analysis: AuthoredAnalysis,
  kind: Kind,
): Record<string, unknown> {
  if (kind === "input") return analysis.inputs;
  if (kind === "decision") return analysis.decisions;
  if (kind === "universe")
    return Object.fromEntries(
      Object.entries(analysis.universes).filter(
        ([, u]) => u.analysis === undefined,
      ),
    );
  return Object.fromEntries(
    Object.entries(analysis.outputs).filter(
      ([, o]) => (o.switch !== undefined) === (kind === "switch"),
    ),
  );
}
export function resolveAddress(
  stack: Stack,
  file: Identity,
  address: Address,
  kinds: readonly Kind[],
): { chain: Declaration[]; element?: Element; undetermined: boolean } {
  const chain: Declaration[] = [];
  let current = file;
  for (const id of address.declarations) {
    const declaration = stack.analyses.get(current)?.declarations.get(id);
    if (!declaration) return { chain, undetermined: false };
    chain.push(declaration);
    if (declaration.outcome !== "reached" || !declaration.reached)
      return { chain, undetermined: true };
    current = declaration.reached;
  }
  const found = kinds.filter((kind) =>
    Object.hasOwn(elements(stack.analysis(current), kind), address.id),
  );
  return {
    chain,
    ...(found.length === 1
      ? { element: stack.element(current, found[0]!, address.id) }
      : {}),
    undetermined: false,
  };
}
export function* resolutions(
  stack: Stack,
  file: Identity,
  analysis: AuthoredAnalysis,
): Generator<Resolution> {
  function make(
    owner: Element | undefined,
    field: Field,
    pointer: Pointer,
    written: string,
    address: Address,
    extra: { key?: string; pin?: string; option?: string } = {},
  ): Resolution {
    const resolved = resolveAddress(stack, file, address, TAKES[field]);
    if (field === "import" && resolved.element?.analysis === file)
      delete resolved.element;
    return {
      file,
      ...(owner ? { owner } : {}),
      field,
      pointer,
      written,
      address,
      ...extra,
      ...resolved,
    };
  }
  for (const [id, output] of Object.entries(analysis.outputs)) {
    const at = ["outputs", id];
    if (output.switch !== undefined) {
      const owner = stack.element(file, "switch", id);
      yield make(
        owner,
        "switch",
        [...at, "switch"],
        output.switch,
        parseAddress(output.switch),
      );
      for (const [option, text] of Object.entries(output.cases)) {
        const ref = parseReference(text);
        yield make(owner, "case", [...at, "cases", option], text, ref.address, {
          ...("pin" in ref ? { pin: ref.pin } : {}),
          option,
        });
      }
      continue;
    }
    const owner = stack.element(file, "output", id);
    for (const [i, text] of output.inputs.entries()) {
      const ref = parseReference(text);
      yield make(
        owner,
        "inputs",
        [...at, "inputs", i],
        text,
        ref.address,
        ref.pin !== undefined ? { pin: ref.pin } : {},
      );
    }
    for (const [i, text] of output.decisions.entries())
      yield make(
        owner,
        "decisions",
        [...at, "decisions", i],
        text,
        parseAddress(text),
      );
  }
  for (const [id, decision] of Object.entries(analysis.decisions))
    for (const [option, opt] of Object.entries(decision.options))
      for (const field of ["requires", "incompatible_with"] as const)
        for (const [i, text] of opt[field].entries()) {
          const ref = parseOptionReference(text);
          yield make(
            stack.element(file, "decision", id),
            field,
            ["decisions", id, "options", option, field, i],
            text,
            ref.decision,
            { option: ref.option },
          );
        }
  for (const [id, universe] of Object.entries(analysis.universes)) {
    const owner = stack.element(file, "universe", id);
    if (universe.analysis !== undefined && universe.universe !== undefined) {
      const text = `${universe.analysis}.${universe.universe}`;
      yield make(owner, "import", ["universes", id], text, parseAddress(text));
    }
    for (const [text, option] of Object.entries(universe.decisions))
      yield make(
        owner,
        "selection",
        ["universes", id, "decisions"],
        text,
        parseAddress(text),
        { key: text, option },
      );
  }
  for (const group of ["prior_insights", "findings"] as const)
    for (const [id, insight] of Object.entries(analysis[group]))
      for (const [i, evidence] of insight.evidence.entries())
        if (evidence.artifact !== undefined) {
          const ref = parseReference(evidence.artifact);
          yield make(
            undefined,
            "artifact",
            [group, id, "evidence", i, "artifact"],
            evidence.artifact,
            ref.address,
            ref.pin !== undefined ? { pin: ref.pin } : {},
          );
        }
}
export async function bind(
  reader: Tree,
  root: string,
  provider: SourceProvider,
): Promise<{ stack?: Stack; diagnostics: Diagnostic[] }> {
  const stack = new Stack(root, reader.commit?.id);
  const diagnostics: Diagnostic[] = [];
  async function read(
    tree: Tree,
    folder: string,
    url?: string,
  ): Promise<Member> {
    const identity = stack.identity(folder, tree.commit?.id);
    const file = folder ? `${folder}/astra.yaml` : "astra.yaml";
    const loaded = loadAnalysisDocument(
      await tree.read(file),
      file,
      identity.commit,
      url,
    );
    diagnostics.push(...loaded.diagnostics);
    const member: Member = {
      identity,
      reader: tree,
      file,
      ...(loaded.document ? { document: loaded.document } : {}),
      ...(loaded.analysis ? { analysis: loaded.analysis } : {}),
      declarations: new Map(),
      ...(url !== undefined ? { url } : {}),
    };
    stack.analyses.set(identity, member);
    return member;
  }
  const top = await read(reader, root, reader.commit?.repository);
  if (!top.analysis || !reader.repo) return { diagnostics };
  const todo = [top];
  while (todo.length) {
    const member = todo.shift()!;
    for (const [id, declared] of Object.entries(member.analysis!.analyses)) {
      const found = await provider.declaration(
        member.reader,
        member.identity.folder,
        declared,
      );
      let reached: Identity | undefined;
      let outcome: Declaration["outcome"] = found.outcome;
      if (
        found.outcome === "reached" &&
        found.reader &&
        found.folder !== undefined
      ) {
        reached = stack.identity(found.folder, found.reader.commit?.id);
        let next = stack.analyses.get(reached);
        if (!next) {
          next = await read(found.reader, found.folder, found.url);
          if (next.analysis) todo.push(next);
        }
        if (!next.analysis) outcome = "invalid";
      }
      const declaration: Declaration = {
        owner: member.identity,
        id,
        declared,
        outcome,
        ...(found.folder !== undefined ? { folder: found.folder } : {}),
        ...(reached ? { reached } : {}),
        ...(found.unreachable
          ? { unreachable: found.unreachable }
          : outcome === "unreachable" && declared.commit
            ? {
                unreachable: [
                  declared.url ?? member.url,
                  declared.commit,
                ] as const,
              }
            : {}),
      };
      member.declarations.set(id, declaration);
    }
  }
  for (const [member, analysis] of stack.determined())
    stack.resolutions.push(...resolutions(stack, member.identity, analysis));
  for (const entry of stack.resolutions) {
    if (entry.field === "switch")
      stack.switches.set(entry.owner!, { decision: entry, cases: new Map() });
    else if (entry.field === "case")
      stack.switches.get(entry.owner!)!.cases.set(entry.option!, entry);
  }
  return { stack, diagnostics };
}
