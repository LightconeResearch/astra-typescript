/** Pure ASTRA universe, switching, driving and result-planning semantics. */
import { diagnostic } from "./documents.js";
import {
  type Stack,
  type Identity,
  type Element,
  type Resolution,
  type Declaration,
  type At,
  type Pointer,
  chainKey,
  identityName,
} from "./model.js";
import type { Diagnostic, Location } from "../reports/types.js";
export type { At } from "./model.js";
export type Chain = readonly Declaration[];
export type Truth = boolean | undefined;
export const isSwitch = (o: { switch?: string }): boolean =>
  o.switch !== undefined;
export const isImport = (u: { analysis?: string }): boolean =>
  u.analysis !== undefined;
export function options(stack: Stack, decision: Element) {
  return stack.analysis(decision.analysis).decisions[decision.id]!.options;
}
export function namesOption(stack: Stack, entry: Resolution): boolean {
  return (
    !!entry.element &&
    entry.option !== undefined &&
    Object.hasOwn(options(stack, entry.element), entry.option)
  );
}
export function ownUniverses(stack: Stack, analysis: Identity): Element[] {
  return Object.entries(stack.analysis(analysis).universes)
    .filter(([, u]) => !isImport(u))
    .map(([id]) => stack.element(analysis, "universe", id));
}
export class Selection {
  constructor(
    readonly universe: Element,
    readonly entries: readonly Resolution[],
    readonly inherited: readonly Resolution[],
  ) {}
  own(entry: Resolution): boolean {
    return entry.owner === this.universe;
  }
  options(decision: Element): Set<string> {
    return new Set(
      this.entries
        .filter((e) => e.element === decision && e.option !== undefined)
        .map((e) => e.option!),
    );
  }
}
export function written(stack: Stack): Map<Element, Resolution[]> {
  const found = new Map<Element, Resolution[]>();
  for (const [m, a] of stack.determined()) {
    for (const id of Object.keys(a.decisions))
      found.set(stack.element(m.identity, "decision", id), []);
    for (const [id, o] of Object.entries(a.outputs))
      found.set(
        stack.element(m.identity, isSwitch(o) ? "switch" : "output", id),
        [],
      );
    for (const u of ownUniverses(stack, m.identity)) found.set(u, []);
  }
  for (const e of stack.resolutions)
    if (e.owner && found.has(e.owner)) found.get(e.owner)!.push(e);
  return found;
}
export function effectiveSelection(
  stack: Stack,
  universe: Element,
  written: Map<Element, Resolution[]>,
  found: Map<Element, Selection | undefined>,
  deriving: readonly Element[] = [],
): Selection | undefined {
  if (found.has(universe)) return found.get(universe);
  const analysis = stack.analysis(universe.analysis);
  const own = written.get(universe) ?? [];
  const named = analysis.universes[universe.id]!.derived_from;
  let result: Selection | undefined;
  if (named === undefined) result = new Selection(universe, own, []);
  else {
    const parent = stack.element(universe.analysis, "universe", named);
    const entry = analysis.universes[named];
    if (
      entry &&
      !isImport(entry) &&
      ![...deriving, universe].includes(parent)
    ) {
      const inherited = effectiveSelection(stack, parent, written, found, [
        ...deriving,
        universe,
      ]);
      if (inherited) {
        const kept = inherited.entries.filter(
          (e) =>
            !own.some(
              (m) =>
                (m.element !== undefined && m.element === e.element) ||
                m.key === e.key,
            ),
        );
        result = new Selection(universe, [...kept, ...own], inherited.entries);
      }
    }
  }
  found.set(universe, result);
  return result;
}
export function selections(
  stack: Stack,
  w: Map<Element, Resolution[]>,
): Map<Element, Selection | undefined> {
  const found = new Map<Element, Selection | undefined>();
  for (const [m] of stack.determined())
    for (const u of ownUniverses(stack, m.identity))
      effectiveSelection(stack, u, w, found);
  return found;
}
export function looping(key: Resolution): [number, number] | undefined {
  const seen: (Identity | undefined)[] = [key.file];
  for (const [i, d] of key.chain.entries()) {
    const back = seen.indexOf(d.reached);
    if (back >= 0) return [i, back];
    if (d.outcome !== "reached") return undefined;
    seen.push(d.reached);
  }
  return undefined;
}
export function cutLoops(start: Identity, chain: Chain): Declaration[] {
  const seen: (Identity | undefined)[] = [start],
    kept: Declaration[] = [];
  for (const d of chain) {
    const back = seen.indexOf(d.reached);
    if (back >= 0) {
      seen.splice(back + 1);
      kept.splice(back);
    } else {
      seen.push(d.reached);
      kept.push(d);
    }
  }
  return kept;
}
export function unlooped(key: Resolution): string {
  return [
    ...cutLoops(key.file, key.chain).map((d) => d.id),
    ...key.address.segments.slice(key.chain.length),
  ].join(".");
}
export type Used = Map<Identity, Set<Element>>;
function extending(
  stack: Stack,
  driver: Identity,
  chain: Chain,
): Declaration[] {
  const last = chain.at(-1);
  const folder = last ? last.reached : driver;
  if (!folder || (last && last.outcome !== "reached")) return [];
  const on = [driver, ...chain.map((d) => d.reached)];
  return [...stack.analyses.get(folder)!.declarations.values()].filter(
    (d) => d.outcome === "reached" && !on.includes(d.reached),
  );
}
function usesAny(
  stack: Stack,
  d: Declaration,
  decisions: Set<Element>,
): boolean {
  const reached = d.reached;
  const a = reached && stack.analyses.get(reached)?.analysis;
  if (!reached || !a) return true;
  return Object.keys(a.decisions).some((id) =>
    decisions.has(stack.element(reached, "decision", id)),
  );
}
export function driven(
  stack: Stack,
  used: Used,
  maybe: Used = new Map(),
): Map<Identity, Chain[]> {
  const found = new Map<Identity, Chain[]>();
  for (const [m] of stack.determined()) {
    const driver = m.identity,
      counted = new Set([
        ...(used.get(driver) ?? []),
        ...(maybe.get(driver) ?? []),
      ]);
    const chains = new Map<string, Chain>();
    for (const key of stack.resolutions)
      if (key.field === "selection" && key.file === driver && !looping(key))
        for (let end = 1; end <= key.chain.length; end++) {
          const part = key.chain.slice(0, end);
          chains.set(chainKey(part), part);
        }
    const todo: Chain[] = [[], ...chains.values()];
    while (todo.length) {
      const chain = todo.shift()!;
      for (const d of extending(stack, driver, chain)) {
        const longer = [...chain, d];
        if (!usesAny(stack, d, counted) && !chains.has(chainKey(longer))) {
          chains.set(chainKey(longer), longer);
          todo.push(longer);
        }
      }
    }
    found.set(driver, [...chains.values()]);
  }
  return found;
}
export function unsettled(
  stack: Stack,
  used: Used,
  maybe: Used,
): Map<Identity, Set<Chain>> {
  const chains = driven(stack, used, maybe),
    found = new Map<Identity, Set<Chain>>();
  for (const [m] of stack.determined()) {
    const identity = m.identity;
    const known = new Set(chains.get(identity)!.map(chainKey));
    const all = new Map<string, Chain>();
    for (const chain of [[], ...chains.get(identity)!])
      for (const d of extending(stack, identity, chain)) {
        const longer = [...chain, d];
        if (
          !known.has(chainKey(longer)) &&
          !usesAny(stack, d, used.get(identity) ?? new Set()) &&
          usesAny(stack, d, maybe.get(identity) ?? new Set())
        )
          all.set(chainKey(longer), longer);
      }
    found.set(identity, new Set(all.values()));
  }
  return found;
}
export function built(
  chains: readonly Chain[],
  driver: Identity,
): Map<Identity, Chain[]> {
  const found = new Map<Identity, Chain[]>([[driver, [[]]]]);
  for (const chain of chains) {
    const last = chain.at(-1)!;
    if (last.outcome === "reached" && last.reached) {
      const own = found.get(last.reached) ?? [];
      own.push(chain);
      found.set(last.reached, own);
    }
  }
  return found;
}
export function imports(stack: Stack): Map<string, Element | undefined> {
  const found = new Map<string, Element | undefined>();
  for (const e of stack.resolutions)
    if (e.field === "import")
      found.set(JSON.stringify([e.file.key, e.owner!.id]), e.element);
  return found;
}
export function pins(
  stack: Stack,
  imported: Map<string, Element | undefined>,
): Map<Resolution, Element | undefined> {
  const found = new Map<Resolution, Element | undefined>();
  for (const e of stack.resolutions) {
    if (e.pin === undefined) continue;
    const entry = stack.analysis(e.file).universes[e.pin];
    let named: Element | undefined;
    if (entry && isImport(entry))
      named = imported.get(JSON.stringify([e.file.key, e.pin]));
    else if (entry) named = stack.element(e.file, "universe", e.pin);
    else if (e.element) {
      const target = stack.analysis(e.element.analysis).universes[e.pin];
      if (target && !isImport(target))
        named = stack.element(e.element.analysis, "universe", e.pin);
    }
    found.set(e, named);
  }
  return found;
}
export function perUniverse(stack: Stack): Set<Element> {
  const found = new Set<Element>();
  for (const [m, a] of stack.determined())
    for (const [id, o] of Object.entries(a.outputs))
      if (!isSwitch(o) && o.decisions.length)
        found.add(stack.element(m.identity, "output", id));
  const reads = stack.resolutions.filter(
    (e) => e.field === "inputs" && e.pin === undefined,
  );
  let grown = true;
  while (grown) {
    grown = false;
    for (const e of reads)
      if (
        e.owner &&
        !found.has(e.owner) &&
        e.element &&
        (found.has(e.element) || e.element.kind === "switch")
      ) {
        found.add(e.owner);
        grown = true;
      }
  }
  return found;
}
export type Depends = Map<Element, readonly (readonly [Element, Resolution])[]>;
export function depends(stack: Stack): Depends {
  const found = new Map<Element, [Element, Resolution][]>();
  for (const e of stack.resolutions)
    if (
      (e.field === "inputs" || e.field === "case") &&
      e.element &&
      (e.element.kind === "output" || e.element.kind === "switch")
    ) {
      const list = found.get(e.owner!) ?? [];
      list.push([e.element, e]);
      found.set(e.owner!, list);
    }
  return found;
}
export function cycles(depends: Depends): Set<Element> {
  const found = new Set<Element>();
  for (const start of depends.keys()) {
    const seen = new Set<Element>(),
      todo = (depends.get(start) ?? []).map(([e]) => e);
    while (todo.length) {
      const current = todo.pop()!;
      if (current === start) {
        found.add(start);
        break;
      }
      if (!seen.has(current)) {
        seen.add(current);
        todo.push(...(depends.get(current) ?? []).map(([e]) => e));
      }
    }
  }
  return found;
}
export class Planned {
  constructor(
    readonly output: Element,
    readonly universe: Element | undefined,
    readonly chains: readonly Chain[],
  ) {}
  get names(): string[] {
    return this.chains.map((c) =>
      [...c.map((d) => d.id), this.output.id].join("."),
    );
  }
  get owner(): Identity {
    return this.universe?.analysis ?? this.output.analysis;
  }
}
export interface Place {
  readonly name: string;
  readonly address: string;
  readonly record: string;
  readonly bytes: string;
}
const join = (...parts: string[]) => parts.filter((p) => p !== "").join("/");
export function places(stack: Stack, result: Planned): Place[] {
  const format = stack.analysis(result.output.analysis).outputs[
    result.output.id
  ]!.format!;
  const u = result.universe?.id;
  return result.names.map((name) => ({
    name,
    address: u === undefined ? name : `${name}#${u}`,
    record: join(
      result.owner.folder,
      ".astra",
      "records",
      ...(u === undefined ? [] : [u]),
      `${name}.json`,
    ),
    bytes: join(
      result.owner.folder,
      "results",
      ...(u === undefined ? [] : [u]),
      `${name}.${format}`,
    ),
  }));
}
export function readIn(
  entry: Resolution,
  universe: Element | undefined,
  pinned: Map<Resolution, Element | undefined>,
  per: Set<Element>,
): Element | undefined {
  const element = entry.element;
  if (!element || (element.kind !== "switch" && !per.has(element)))
    return undefined;
  return entry.pin === undefined ? universe : pinned.get(entry);
}
export interface Taken {
  readonly option: string;
  readonly case?: Resolution;
}
export interface Step {
  readonly switch: Element;
  readonly universe: Element;
  readonly option: string;
  readonly case: Resolution;
}
export class Through {
  constructor(
    readonly entry: Resolution,
    readonly target: Element,
    readonly universe: Element | undefined,
    readonly steps: readonly Step[],
  ) {}
  get chain(): Chain {
    return [...this.entry.chain, ...this.steps.flatMap((s) => s.case.chain)];
  }
}
export interface Cause {
  readonly switch: Element;
  readonly universe: Element;
  readonly option: string;
}
export const both = (a: Truth, b: Truth): Truth =>
  a === false || b === false
    ? false
    : a === undefined || b === undefined
      ? undefined
      : true;
export class Meaning {
  private readonly takenCache = new Map<At, Taken | undefined>();
  private readonly builtCache = new Map<At, Truth>();
  constructor(
    readonly stack: Stack,
    readonly written: Map<Element, Resolution[]>,
    readonly selections: Map<Element, Selection | undefined>,
    readonly pinned: Map<Resolution, Element | undefined>,
    readonly perUniverse: Set<Element>,
    readonly cycles: Set<Element>,
  ) {}
  taken(switch_: Element, universe?: Element): Taken | undefined {
    const key = this.stack.at(switch_, universe);
    if (!this.takenCache.has(key))
      this.takenCache.set(key, this.take(switch_, universe));
    return this.takenCache.get(key);
  }
  private take(switch_: Element, universe?: Element): Taken | undefined {
    const selection = universe && this.selections.get(universe);
    if (this.cycles.has(switch_) || !selection) return undefined;
    const resolved = this.stack.switches.get(switch_)!,
      decision = resolved.decision.element;
    if (!decision) return undefined;
    const selected = [...selection.options(decision)];
    if (selected.length !== 1) return undefined;
    const option = selected[0]!,
      known = options(this.stack, decision);
    if (!Object.hasOwn(known, option) || known[option]!.excluded !== undefined)
      return undefined;
    const case_ = resolved.cases.get(option);
    if (
      !case_ &&
      [...resolved.cases.keys()].some((k) => !Object.hasOwn(known, k))
    )
      return undefined;
    return { option, ...(case_ ? { case: case_ } : {}) };
  }
  built(element: Element, universe?: Element): Truth {
    const key = this.stack.at(element, universe);
    if (!this.builtCache.has(key)) {
      this.builtCache.set(key, undefined);
      this.builtCache.set(key, this.judged(element, universe));
    }
    return this.builtCache.get(key);
  }
  private judged(element: Element, universe?: Element): Truth {
    if (this.cycles.has(element)) return undefined;
    if (
      element.kind === "input" ||
      (element.kind === "output" && !this.perUniverse.has(element))
    )
      return true;
    if (!universe || !this.selections.get(universe)) return undefined;
    if (element.kind === "switch") {
      const taken = this.taken(element, universe);
      return !taken
        ? undefined
        : !taken.case
          ? false
          : this.reads(taken.case, universe);
    }
    let found: Truth = true;
    for (const e of this.written.get(element) ?? [])
      if (e.field === "inputs" && e.pin === undefined)
        found = both(found, this.reads(e, universe));
    return found;
  }
  private reads(entry: Resolution, universe: Element): Truth {
    if (!entry.element || (entry.pin !== undefined && !this.pinned.get(entry)))
      return undefined;
    return this.built(
      entry.element,
      readIn(entry, universe, this.pinned, this.perUniverse),
    );
  }
  cause(element: Element, universe?: Element): Cause | undefined {
    if (this.built(element, universe) !== false || !universe) return undefined;
    if (element.kind === "switch") {
      const taken = this.taken(element, universe)!;
      if (!taken.case)
        return { switch: element, universe, option: taken.option };
      return this.cause(
        taken.case.element!,
        readIn(taken.case, universe, this.pinned, this.perUniverse),
      );
    }
    for (const e of this.written.get(element) ?? [])
      if (
        e.field === "inputs" &&
        e.pin === undefined &&
        this.reads(e, universe) === false
      )
        return this.cause(
          e.element!,
          readIn(e, universe, this.pinned, this.perUniverse),
        );
    return undefined;
  }
  through(entry: Resolution, universe?: Element): Through | undefined {
    const steps: Step[] = [];
    let current = entry,
      at = universe;
    const seen = new Set<Element>();
    while (true) {
      const e = current.element;
      if (!e || (current.pin !== undefined && !this.pinned.get(current)))
        return undefined;
      at = readIn(current, at, this.pinned, this.perUniverse);
      if (e.kind !== "switch") {
        if (this.perUniverse.has(e) && !at) return undefined;
        return new Through(entry, e, at, steps);
      }
      if (seen.has(e)) return undefined;
      seen.add(e);
      const taken = this.taken(e, at);
      if (!at || !taken?.case) return undefined;
      steps.push({
        switch: e,
        universe: at,
        option: taken.option,
        case: taken.case,
      });
      current = taken.case;
    }
  }
}
export interface PinRead {
  readonly entry: Resolution;
  readonly universe: Element;
  readonly uses: Set<Element>;
}
export interface Run {
  readonly driver: Identity;
  readonly reached: Map<At, undefined>;
  readonly planned: Map<At, Truth>;
  readonly reads: readonly (readonly [Resolution, Element | undefined])[];
  readonly pins: readonly PinRead[];
  readonly used: Map<Element, Set<Element>>;
  readonly maybe: Map<Element, Set<Element>>;
  readonly branches: Map<Element, Set<Element>>;
  readonly blind: Set<Identity>;
}
function each(e: Element | undefined, per: Set<Element>): boolean {
  return !!e && (e.kind === "switch" || per.has(e));
}
function roots(stack: Stack, driver: Identity): Element[] {
  const named = new Set<Element>(),
    read = new Set<Element>();
  for (const e of stack.resolutions)
    if (e.file === driver && e.element) {
      if (e.field === "case") named.add(e.element);
      else if (e.field === "inputs") read.add(e.element);
    }
  const found: Element[] = [];
  for (const [id, o] of Object.entries(stack.analysis(driver).outputs)) {
    const kind = isSwitch(o) ? "switch" : "output";
    const e = stack.element(driver, kind, id);
    if (!named.has(e) && (kind === "output" || !read.has(e))) found.push(e);
  }
  return found;
}
function cited(stack: Stack, driver: Identity): Resolution[] {
  return stack.resolutions.filter(
    (e) => e.field === "artifact" && e.file === driver,
  );
}
function listed(w: Map<Element, Resolution[]>, e: Element): Set<Element> {
  return new Set(
    (w.get(e) ?? [])
      .filter((r) => r.field === "decisions" && r.element)
      .map((r) => r.element!),
  );
}
function switchedOn(stack: Stack, e: Element): Set<Element> {
  const decision = stack.switches.get(e)?.decision.element;
  return new Set(decision ? [decision] : []);
}
const addSet = <K, T>(map: Map<K, Set<T>>, key: K, values: Iterable<T>) => {
  let into = map.get(key);
  if (!into) {
    into = new Set();
    map.set(key, into);
  }
  for (const value of values) into.add(value);
};
function branches(
  stack: Stack,
  w: Map<Element, Resolution[]>,
  pinned: Map<Resolution, Element | undefined>,
  per: Set<Element>,
  starts: readonly At[],
  driver?: Identity,
  evidence: readonly Resolution[] = [],
  own: readonly Element[] = [],
): { found: Map<Element | undefined, Set<Element>>; blind: Set<Identity> } {
  const found = new Map<Element | undefined, Set<Element>>(),
    blind = new Set<Identity>(),
    seen = new Set<At>(),
    todo: At[] = [...starts];
  const nothing = () => {
    if (driver) blind.add(driver);
  };
  const follow = (entry: Resolution, u?: Element) => {
    const e = entry.element;
    if (!e) {
      nothing();
      return;
    }
    if (entry.pin !== undefined && !pinned.get(entry)) {
      if (driver) {
        blind.add(driver);
        blind.add(entry.file);
        blind.add(e.analysis);
      }
      return;
    }
    if (e.kind === "input") return;
    const at = readIn(entry, u, pinned, per);
    if ((e.kind === "switch" || per.has(e)) && !at) return;
    todo.push(stack.at(e, at));
  };
  for (const e of evidence)
    for (const u of e.pin === undefined && each(e.element, per)
      ? own
      : [undefined])
      follow(e, u);
  while (todo.length) {
    const key = todo.pop()!;
    if (seen.has(key)) continue;
    seen.add(key);
    const [e, u] = key;
    if (e.kind === "switch") {
      const resolved = stack.switches.get(e)!;
      if (!resolved.decision.element) nothing();
      addSet(found, u, switchedOn(stack, e));
      for (const c of resolved.cases.values()) follow(c, u);
      continue;
    }
    for (const entry of w.get(e) ?? []) {
      if (entry.field === "decisions") {
        if (!entry.element) nothing();
        else addSet(found, u, [entry.element]);
      } else if (entry.field === "inputs") follow(entry, u);
    }
  }
  return { found, blind };
}
export function run(
  stack: Stack,
  meaning: Meaning,
  w: Map<Element, Resolution[]>,
  select: Map<Element, Selection | undefined>,
  pinned: Map<Resolution, Element | undefined>,
  per: Set<Element>,
  cycle: Set<Element>,
  driver: Identity,
): Run {
  const own = ownUniverses(stack, driver),
    reached = new Map<At, undefined>(),
    reads: [Resolution, Element | undefined][] = [],
    readKeys = new Map<Resolution, Set<Element | undefined>>(),
    edges = new Map<At, [At, Resolution][]>(),
    pinning: [Resolution, Element][] = [],
    undetermined: At[] = [],
    rootPoints: At[] = [],
    todo: At[] = [];
  const read = (e: Resolution, u?: Element) => {
    const values = readKeys.get(e) ?? new Set();
    if (!values.has(u)) {
      values.add(u);
      readKeys.set(e, values);
      reads.push([e, u]);
    }
  };
  const reach = (e: Element, u?: Element): At => {
    const at = stack.at(e, u);
    if (!reached.has(at)) {
      reached.set(at, undefined);
      todo.push(at);
    }
    return at;
  };
  const follow = (entry: Resolution, u?: Element): At | undefined => {
    const e = entry.element;
    if (!e || e.kind === "input") return undefined;
    if (entry.field === "case" && entry.pin !== undefined && !pinned.get(entry))
      return undefined;
    const at = readIn(entry, u, pinned, per);
    if (each(e, per) && !at) return undefined;
    read(entry, at);
    if (
      entry.pin !== undefined &&
      at &&
      at.analysis !== driver &&
      !pinning.some(([r, x]) => r === entry && x === at)
    )
      pinning.push([entry, at]);
    return reach(e, at);
  };
  for (const e of roots(stack, driver))
    for (const u of each(e, per) ? own : [undefined])
      rootPoints.push(reach(e, u));
  const starts = [...rootPoints];
  for (const entry of cited(stack, driver))
    for (const u of entry.pin === undefined && each(entry.element, per)
      ? own
      : [undefined]) {
      const point = follow(entry, u);
      if (point) rootPoints.push(point);
    }
  const edge = (from: At, to: At, e: Resolution) => {
    const list = edges.get(from) ?? [];
    list.push([to, e]);
    edges.set(from, list);
  };
  while (todo.length) {
    const key = todo.shift()!,
      [e, u] = key;
    if (cycle.has(e)) {
      undetermined.push(key);
      continue;
    }
    if (u && !select.get(u)) continue;
    if (e.kind === "switch") {
      read(stack.switches.get(e)!.decision, u);
      const taken = meaning.taken(e, u);
      if (!taken) undetermined.push(key);
      else if (taken.case) {
        const target = follow(taken.case, u);
        if (target) edge(key, target, taken.case);
      }
      continue;
    }
    for (const entry of w.get(e) ?? []) {
      if (entry.field === "decisions") read(entry, u);
      else if (entry.field === "inputs") {
        const target = follow(entry, u);
        if (target) edge(key, target, entry);
      }
    }
  }
  const status = new Map<At, Truth>(),
    improved: At[] = [];
  const plan = (key: At, value: Truth) => {
    if (
      value === false ||
      (status.has(key) && (status.get(key) === true || value === undefined))
    )
      return;
    status.set(key, value);
    improved.push(key);
  };
  for (const key of rootPoints) plan(key, meaning.built(...key));
  while (improved.length) {
    const key = improved.shift()!;
    for (const [target] of edges.get(key) ?? [])
      plan(target, both(status.get(key), meaning.built(...target)));
  }
  const planned = new Map(
    [...reached.keys()]
      .filter((k) => status.has(k) && k[0].kind === "output")
      .map((k) => [k, status.get(k)]),
  );
  const used = new Map<Element, Set<Element>>(),
    maybe = new Map<Element, Set<Element>>();
  for (const [[e, u], value] of planned)
    if (u) addSet(value === true ? used : maybe, u, listed(w, e));
  for (const [e, u] of reached.keys())
    if (e.kind === "switch" && u && !cycle.has(e))
      addSet(used, u, switchedOn(stack, e));
  for (const point of undetermined) {
    const beyond = branches(stack, w, pinned, per, [point]);
    for (const [u, ds] of beyond.found) if (u) addSet(maybe, u, ds);
  }
  const pinsRead: PinRead[] = pinning.map(([entry, u]) => {
    const uses = new Set<Element>(),
      seen = new Set<At>(),
      todo = [stack.at(entry.element!, u)];
    while (todo.length) {
      const key = todo.pop()!;
      if (seen.has(key)) continue;
      seen.add(key);
      const [e] = key;
      for (const d of e.kind === "switch"
        ? switchedOn(stack, e)
        : e.kind === "output"
          ? listed(w, e)
          : [])
        uses.add(d);
      for (const [target, r] of edges.get(key) ?? [])
        if (r.pin === undefined) todo.push(target);
    }
    return { entry, universe: u, uses };
  });
  for (const [u, ds] of maybe) for (const d of used.get(u) ?? []) ds.delete(d);
  const static_ = branches(
    stack,
    w,
    pinned,
    per,
    starts,
    driver,
    cited(stack, driver),
    own,
  );
  return {
    driver,
    reached,
    planned,
    reads,
    pins: pinsRead,
    used,
    maybe,
    branches: new Map(
      own.map((u) => [u, static_.found.get(u) ?? new Set<Element>()]),
    ),
    blind: static_.blind,
  };
}
export interface Building {
  readonly universes: Map<Element, Map<Identity, Chain[]>>;
  readonly planned: Map<At, Planned>;
  readonly reads: Run["reads"];
  readonly run: Run;
}
export function building(
  stack: Stack,
  run: Run,
  chains: Map<Identity, Chain[]>,
): Building {
  const universes = new Map<Element, Map<Identity, Chain[]>>();
  for (const u of [
    ...ownUniverses(stack, run.driver),
    ...run.reads.map(([, u]) => u).filter((u): u is Element => u !== undefined),
  ])
    if (!universes.has(u))
      universes.set(u, built(chains.get(u.analysis) ?? [], u.analysis));
  const planned = new Map<At, Planned>();
  for (const [[output, u], status] of run.planned) {
    const named = u ? universes.get(u)?.get(output.analysis) : [[]];
    if (status === true && named)
      planned.set(stack.at(output, u), new Planned(output, u, named));
  }
  return { universes, planned, reads: run.reads, run };
}

export class Context {
  readonly written;
  readonly selections;
  readonly imports;
  readonly pins;
  readonly perUniverse;
  readonly depends;
  readonly cycles;
  readonly meaning;
  readonly runs = new Map<Identity, Run>();
  readonly driven;
  readonly unsettled;
  readonly building;
  private readonly usedUnion: Used = new Map();
  private readonly maybeUnion: Used = new Map();
  constructor(readonly stack: Stack) {
    this.written = written(stack);
    this.selections = selections(stack, this.written);
    this.imports = imports(stack);
    this.pins = pins(stack, this.imports);
    this.perUniverse = perUniverse(stack);
    this.depends = depends(stack);
    this.cycles = cycles(this.depends);
    this.meaning = new Meaning(
      stack,
      this.written,
      this.selections,
      this.pins,
      this.perUniverse,
      this.cycles,
    );
    for (const [m] of stack.determined()) {
      const r = run(
        stack,
        this.meaning,
        this.written,
        this.selections,
        this.pins,
        this.perUniverse,
        this.cycles,
        m.identity,
      );
      this.runs.set(m.identity, r);
      const u = new Set<Element>(),
        p = new Set<Element>();
      for (const x of ownUniverses(stack, m.identity)) {
        for (const d of r.used.get(x) ?? []) u.add(d);
        for (const d of r.maybe.get(x) ?? []) p.add(d);
      }
      this.usedUnion.set(m.identity, u);
      this.maybeUnion.set(m.identity, p);
    }
    this.driven = driven(stack, this.usedUnion, this.maybeUnion);
    this.unsettled = unsettled(stack, this.usedUnion, this.maybeUnion);
    this.building = building(stack, this.runs.get(stack.root)!, this.driven);
  }
  at(identity: Identity, pointer: Pointer, key?: string): Location {
    return this.stack.location(identity, pointer, key);
  }
  diagnostic(
    code: string,
    message: string,
    location: Location,
    related: readonly Location[] = [],
  ): Diagnostic {
    return diagnostic(code, message, location, related);
  }
  used(universe: Element): Set<Element> {
    return this.runs.get(universe.analysis)?.used.get(universe) ?? new Set();
  }
  maybe(universe: Element): Set<Element> {
    return this.runs.get(universe.analysis)?.maybe.get(universe) ?? new Set();
  }
  built(element: Element, universe?: Element): Truth {
    return this.meaning.built(element, universe);
  }
  namesNothing(entry: Resolution): boolean {
    return !entry.element;
  }
  onCycle(element?: Element): boolean {
    return !!element && this.cycles.has(element);
  }
  unsettledIn(universe: Element): Set<Identity> {
    const driver = universe.analysis,
      found = new Set<Identity>(),
      todo = [...(this.unsettled.get(driver) ?? [])]
        .map((c) => c.at(-1)?.reached)
        .filter((i): i is Identity => !!i);
    while (todo.length) {
      const id = todo.pop()!;
      if (found.has(id)) continue;
      found.add(id);
      for (const d of this.stack.analyses.get(id)?.declarations.values() ?? [])
        if (d.reached) todo.push(d.reached);
    }
    for (const id of built(this.driven.get(driver) ?? [], driver).keys())
      found.delete(id);
    return found;
  }
  unsettledThrough(entry: Resolution): boolean {
    const unsettled = this.unsettled.get(entry.file) ?? new Set();
    for (let end = 1; end <= entry.chain.length; end++)
      if (
        [...unsettled].some(
          (c) => chainKey(c) === chainKey(entry.chain.slice(0, end)),
        )
      )
        return true;
    return false;
  }
  named(universes: Iterable<Element>, file: Identity): string {
    const groups = new Map<Identity, string[]>();
    for (const u of universes) {
      const ids = groups.get(u.analysis) ?? [];
      ids.push("`" + u.id + "`");
      groups.set(u.analysis, ids);
    }
    const list = (xs: string[]) =>
      xs.length < 2
        ? (xs[0] ?? "")
        : xs.slice(0, -1).join(", ") + " and " + xs.at(-1);
    return list(
      [...groups].map(([a, ids]) =>
        a === file ? list(ids) : `${list(ids)} of \`${identityName(a)}\``,
      ),
    );
  }
}
