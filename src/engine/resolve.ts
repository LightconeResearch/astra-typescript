/** The Python-compatible resolved report, derived from a valid semantic context. */
import type {
  ResolvedAnalysis,
  Analysis,
  Commit,
  Output,
  Universe,
  Insight,
  Evidence,
  Result,
  Diagnostic,
  Source,
} from "../reports/types.js";
import { RESOLVED_ANALYSIS_SCHEMA_VERSION } from "../reports/types.js";
import {
  type Stack,
  type Identity,
  type Element,
  type At,
  type Resolution,
  type Pointer,
  identityName,
} from "./model.js";
import {
  Context,
  Planned,
  type Selection,
  type Through,
  ownUniverses,
  places,
  isSwitch,
} from "./universes.js";
import { fill, TEMPLATE } from "./grammar.js";
import type { AuthoredInsight } from "./documents.js";
import { join } from "../sources/paths.js";
export interface Resolved {
  readonly context: Context;
  readonly analysis: ResolvedAnalysis;
  readonly keys: Map<Identity, string>;
  readonly planned: Map<string, Planned>;
}
export function reads(
  context: Context,
  result: Planned,
): readonly (readonly [Resolution, Through])[] {
  const found: [Resolution, Through][] = [];
  for (const entry of context.written.get(result.output) ?? [])
    if (entry.field === "inputs") {
      const through = context.meaning.through(entry, result.universe);
      if (!through) throw new Error("Undetermined planned input");
      found.push([entry, through]);
    }
  return found;
}
export function inputPath(stack: Stack, input: Element): string {
  const path = join(
    input.analysis.folder,
    stack.analysis(input.analysis).inputs[input.id]!.path,
  );
  if (path === undefined) throw new Error("Input outside repository");
  return path;
}
export function selected(
  entries: readonly Resolution[],
  selection?: Selection,
): Record<string, string | undefined> {
  return Object.fromEntries(
    entries
      .filter((e) => e.field === "decisions")
      .map((e) => [
        e.written,
        selection && e.element
          ? [...selection.options(e.element)].sort()[0]
          : undefined,
      ]),
  );
}
export function relativePath(from: string, to: string): string {
  const a = from.split("/").filter((x) => x && x !== "."),
    b = to.split("/").filter((x) => x && x !== ".");
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common])
    common++;
  return (
    [...a.slice(common).map(() => ".."), ...b.slice(common)].join("/") || "."
  );
}
function keys(stack: Stack): Map<Identity, string> {
  const chains = new Map<Identity, string[]>([[stack.root, []]]);
  let reached = [stack.root];
  while (reached.length) {
    const found = new Map<Identity, string[]>();
    for (const owner of reached)
      for (const [id, d] of stack.analyses.get(owner)!.declarations) {
        const target = d.reached;
        if (!target) continue;
        const chain = [...chains.get(owner)!, id];
        const old = found.get(target);
        if (!chains.has(target) && (!old || chain.join(".") < old.join(".")))
          found.set(target, chain);
      }
    for (const [k, v] of found) chains.set(k, v);
    reached = [...found.keys()];
  }
  return new Map([...chains].map(([id, c]) => [id, c.join(".")]));
}
function ordered(context: Context): Map<At, Planned> {
  const all = context.building.planned,
    found = new Map<At, Planned>(),
    visiting = new Set<At>();
  function visit(at: At) {
    if (found.has(at)) return;
    if (visiting.has(at)) throw new Error("Cyclic planned results");
    const planned = all.get(at);
    if (!planned) throw new Error("Missing planned dependency");
    visiting.add(at);
    for (const [, through] of reads(context, planned))
      if (through.target.kind === "output")
        visit(context.stack.at(through.target, through.universe));
    found.set(at, planned);
    visiting.delete(at);
  }
  for (const at of all.keys()) visit(at);
  return found;
}
const ref = (key: string, collection: string, id: string) =>
  [key, collection, id].filter(Boolean).join(".");
function fromRoot(stack: Stack, identity: Identity, path: string): string {
  return identity.commit !== stack.root.commit
    ? path || "."
    : relativePath(stack.root.folder, path);
}
const defined = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
class Builder {
  readonly stack;
  constructor(
    readonly context: Context,
    readonly keys: Map<Identity, string>,
    readonly ids: Map<At, string>,
  ) {
    this.stack = context.stack;
  }
  ref(e: Element): string {
    return ref(this.keys.get(e.analysis)!, `${e.kind}s`, e.id);
  }
  commit(identity: Identity): Commit | undefined {
    if (identity.commit === this.stack.root.commit) return undefined;
    return defined({
      id: identity.commit!,
      repository: this.stack.analyses.get(identity)?.url,
    });
  }
  analysis(identity: Identity): Analysis {
    const s = this.stack,
      key = this.keys.get(identity)!,
      m = s.analyses.get(identity)!,
      a = s.analysis(identity);
    return defined({
      key,
      folder: fromRoot(s, identity, identity.folder),
      commit: this.commit(identity),
      label: a.label,
      description: a.description,
      tags: a.tags,
      declares: Object.fromEntries(
        [...m.declarations]
          .filter(([, d]) => d.reached)
          .map(([id, d]) => [id, this.keys.get(d.reached!)!]),
      ),
      inputs: Object.entries(a.inputs).map(([id, e]) =>
        defined({
          ref: ref(key, "inputs", id),
          path: fromRoot(
            s,
            identity,
            inputPath(s, s.element(identity, "input", id)),
          ),
          label: e.label,
          description: e.description,
          tags: e.tags,
        }),
      ),
      decisions: Object.entries(a.decisions).map(([id, e]) =>
        defined({
          ref: ref(key, "decisions", id),
          options: Object.entries(e.options).map(([option, o]) =>
            defined({
              id: option,
              label: o.label,
              description: o.description,
              tags: o.tags,
              excluded: o.excluded,
              insights: o.insights.map((i) => ref(key, "prior_insights", i)),
            }),
          ),
          label: e.label,
          rationale: e.rationale,
          tags: e.tags,
        }),
      ),
      outputs: Object.entries(a.outputs)
        .filter(([, o]) => !isSwitch(o))
        .map(([id]) => this.output(s.element(identity, "output", id))),
      prior_insights: this.insights(
        identity,
        "prior_insights",
        a.prior_insights,
      ),
      findings: this.insights(identity, "findings", a.findings),
      universes: ownUniverses(s, identity).map((u) => this.universe(u)),
    });
  }
  output(e: Element): Output {
    const o = this.stack.analysis(e.analysis).outputs[e.id]!;
    return defined({
      ref: this.ref(e),
      type: o.type!,
      format: o.format!,
      label: o.label,
      description: o.description,
      tags: o.tags,
      resources: o.recipe?.resources,
      decisions: [
        ...new Set(
          (this.context.written.get(e) ?? [])
            .filter((x) => x.field === "decisions" && x.element)
            .map((x) => this.ref(x.element!)),
        ),
      ],
    });
  }
  universe(e: Element): Universe {
    const o = this.stack.analysis(e.analysis).universes[e.id]!,
      selection = this.context.selections.get(e)!;
    const chosen = [...this.context.used(e)]
      .map((d) => [this.ref(d), [...selection.options(d)].sort()[0]!] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return defined({
      ref: this.ref(e),
      selection: Object.fromEntries(chosen),
      label: o.label,
      description: o.description,
      tags: o.tags,
    });
  }
  insights(
    identity: Identity,
    collection: "prior_insights" | "findings",
    written: Record<string, AuthoredInsight>,
  ): Insight[] {
    return Object.entries(written).map(([id, e]) =>
      defined({
        ref: ref(this.keys.get(identity)!, collection, id),
        kind:
          collection === "findings"
            ? ("finding" as const)
            : ("prior_insight" as const),
        claim: e.claim,
        evidence: e.evidence.map(
          (v, i): Evidence =>
            defined({
              doi: v.doi,
              version: v.version,
              cites:
                v.artifact === undefined
                  ? undefined
                  : this.cited(identity, [
                      collection,
                      id,
                      "evidence",
                      i,
                      "artifact",
                    ]),
              quote: v.quote,
              location: v.location,
              artifact: v.artifact,
            }),
        ),
        label: e.label,
        description: e.description,
        scope: e.scope,
        tags: e.tags,
      }),
    );
  }
  cited(identity: Identity, pointer: Pointer): string[] {
    const entry = this.stack.resolutions.find(
      (e) =>
        e.field === "artifact" &&
        e.file === identity &&
        JSON.stringify(e.pointer) === JSON.stringify(pointer),
    )!;
    const e = entry.element!;
    const universes: readonly (Element | undefined)[] =
      entry.pin === undefined &&
      (e.kind === "switch" || this.context.perUniverse.has(e))
        ? ownUniverses(this.stack, this.stack.root)
        : [undefined];
    const found = new Set<string>();
    for (const u of universes) {
      const through = this.context.meaning.through(entry, u);
      if (through) {
        const id = this.ids.get(
          this.stack.at(through.target, through.universe),
        );
        if (id !== undefined) found.add(id);
      }
    }
    return [...found];
  }
  result(planned: Planned): Result {
    const s = this.stack,
      output = planned.output,
      folder = output.analysis.folder,
      own = places(s, planned),
      here = new Set([planned.owner.commit, output.analysis.commit]),
      sources: Source[] = [],
      given: Record<string, string> = Object.create(null);
    for (const [entry, through] of reads(this.context, planned)) {
      const target = through.target;
      let path: string, at: string | undefined;
      if (target.kind === "input") {
        sources.push({ entry: entry.written, input: this.ref(target) });
        path = inputPath(s, target);
        at = target.analysis.commit;
      } else {
        const key = s.at(target, through.universe),
          read = this.context.building.planned.get(key)!;
        sources.push({ entry: entry.written, result: this.ids.get(key)! });
        path = places(s, read)[0]!.bytes;
        at = read.owner.commit;
      }
      here.add(at);
      given[entry.written] = relativePath(folder, path);
    }
    let command: string | undefined;
    if (here.size === 1 && here.has(s.root.commit)) {
      const recipe = s.analysis(output.analysis).outputs[output.id]!.recipe!;
      command = fill(recipe.command, {
        inputs: given,
        decisions: selected(
          this.context.written.get(output) ?? [],
          planned.universe
            ? this.context.selections.get(planned.universe)
            : undefined,
        ),
        output: relativePath(folder, own[0]!.bytes),
      });
    }
    return defined({
      id: this.ids.get(s.at(output, planned.universe))!,
      output: this.ref(output),
      places: own.map((p) => ({
        address: p.address,
        record_path: fromRoot(s, planned.owner, p.record),
        file_path: fromRoot(s, planned.owner, p.bytes),
      })),
      universe: planned.universe ? this.ref(planned.universe) : undefined,
      inputs: sources,
      command,
      commit: this.commit(planned.owner),
    });
  }
}
function note(
  context: Context,
  code: string,
  message: string,
  file: Identity,
  pointer: Pointer,
): Diagnostic {
  return {
    code,
    level: "note",
    message,
    location: context.at(file, pointer),
    related: [],
  };
}
function commandPaths(command: string): string[] {
  const marked = command.replace(
    TEMPLATE,
    (text: string, p: string | undefined) =>
      p === undefined ? text[0]! : "\0",
  );
  const found: string[] = [];
  for (const word of marked.match(/[^\s=:;&|<>()'"`,]+/g) ?? [])
    if (!word.includes("\0") && !word.startsWith("/") && !found.includes(word))
      found.push(word);
  return found;
}
async function notes(context: Context): Promise<Diagnostic[]> {
  const s = context.stack,
    result: Diagnostic[] = [],
    editable = [...s.determined()].filter(
      ([m]) => m.identity.commit === s.root.commit,
    ),
    read = new Set(context.building.reads.map(([e]) => e));
  for (const [e, u] of context.pins)
    if (
      u &&
      e.file.commit === s.root.commit &&
      read.has(e) &&
      !Object.hasOwn(s.analysis(e.file).universes, e.pin!)
    )
      result.push(
        note(
          context,
          "FALLBACK_PIN",
          `\`${e.written}\` names \`${e.pin}\` of \`${identityName(u.analysis)}\` only because this file has no universe \`${e.pin}\`: adding one, or an import of that id, would change what it names`,
          e.file,
          e.pointer,
        ),
      );
  const planned = new Set([...context.building.planned.keys()].map(([e]) => e)),
    cased = new Map<Element, Element>();
  for (const e of s.resolutions)
    if (
      e.field === "case" &&
      e.file === s.root &&
      e.element &&
      !cased.has(e.element)
    )
      cased.set(e.element, e.owner!);
  for (const [m, a] of editable)
    for (const [id, o] of Object.entries(a.outputs)) {
      const e = s.element(m.identity, "output", id);
      if (isSwitch(o) || planned.has(e)) continue;
      const sw = cased.get(e);
      const why =
        m.identity !== s.root
          ? "no planned result reads it and the root's evidence doesn't cite it"
          : sw
            ? `only a case of \`${sw.id}\` names it, so it is planned only where something planned reads it, and nothing does`
            : !ownUniverses(s, s.root).length
              ? "it is built per universe and the root has no universes"
              : "it is built in none of the root's universes";
      result.push(
        note(
          context,
          "UNPLANNED_OUTPUT",
          `\`${id}\` has no planned result: ${why}, so a check of the root never covers it`,
          m.identity,
          ["outputs", id],
        ),
      );
    }
  const reached = context.building.run,
    reads_ = new Set(
      reached.reads
        .filter(([e]) => e.field === "inputs" || e.field === "case")
        .filter(([e]) => e.element)
        .map(([e, u]) => s.at(e.element!, u)),
    ),
    causes = new Map<
      string,
      { output: Element; switch: Element; option: string; universes: Element[] }
    >();
  for (const [e, u] of reached.reached.keys()) {
    if (!u || (e.kind === "switch" && reads_.has(s.at(e, u)))) continue;
    const cause = context.meaning.cause(e, u);
    if (cause) {
      const key = JSON.stringify([e.key, cause.switch.key, cause.option]);
      const found = causes.get(key) ?? {
        output: e,
        switch: cause.switch,
        option: cause.option,
        universes: [],
      };
      found.universes.push(u);
      causes.set(key, found);
    }
  }
  for (const { output, switch: sw, option, universes } of causes.values()) {
    const whose =
      sw.analysis === output.analysis
        ? ""
        : ` of \`${identityName(sw.analysis)}\``;
    const which = sw === output ? "it" : `\`${sw.id}\`${whose}`;
    result.push(
      note(
        context,
        "NOT_BUILT",
        `\`${output.id}\` isn't built in ${context.named(universes, output.analysis)}: ${which} has no case there for \`${option}\`, the option its decision selects`,
        output.analysis,
        ["outputs", output.id],
      ),
    );
  }
  for (const [m, a] of editable)
    for (const [id, o] of Object.entries(a.outputs)) {
      if (!o.recipe) continue;
      const named: string[] = [];
      for (const path of commandPaths(o.recipe.command)) {
        const inside = join("", path);
        if (inside === undefined) {
          named.push(`\`${path}\`, outside its analysis's folder`);
          continue;
        }
        const parts = inside.split("/").slice(0, -1);
        for (let count = 1; count <= parts.length; count++) {
          const inner = [m.identity.folder, ...parts.slice(0, count)]
            .filter(Boolean)
            .join("/");
          if ((await m.reader.stat(`${inner}/astra.yaml`))?.kind === "file") {
            named.push(
              `\`${path}\`, inside \`${inner}\`, which holds an analysis of its own`,
            );
            break;
          }
        }
      }
      if (named.length)
        result.push(
          context.diagnostic(
            "CODE_OUTSIDE_ANALYSIS",
            `the command names ${named.join("; ")}: a recipe should run only code tracked in its analysis's folder, outside every folder below it that holds an analysis of its own, or that its output's inputs give it`,
            context.at(m.identity, ["outputs", id, "recipe", "command"]),
          ),
        );
    }
  return result;
}
export async function resolve(context: Context): Promise<Resolved> {
  const s = context.stack,
    ks = keys(s),
    all = ordered(context),
    ids = new Map<At, string>();
  for (const [at, p] of all) {
    const address = places(s, p)[0]!.address,
      key = ks.get(p.owner)!;
    ids.set(at, key ? `${key}:${address}` : address);
  }
  const builder = new Builder(context, ks, ids),
    head = await s.analyses.get(s.root)!.reader.repo!.head();
  const analysis: ResolvedAnalysis = defined({
    spec_version: s.analysis(s.root).spec_version,
    head,
    analyses: [...ks.keys()]
      .sort((a, b) =>
        ks.get(a)! < ks.get(b)! ? -1 : ks.get(a)! > ks.get(b)! ? 1 : 0,
      )
      .map((i) => builder.analysis(i)),
    results: [...all.values()].map((p) => builder.result(p)),
    notes: await notes(context),
    schema_version: RESOLVED_ANALYSIS_SCHEMA_VERSION,
  });
  return {
    context,
    analysis,
    keys: ks,
    planned: new Map([...all].map(([at, p]) => [ids.get(at)!, p])),
  };
}
