/** Driving chains, universe membership, pins and result-place rules. */
import type { Context } from "../universes.js";
import { built, looping, unlooped, ownUniverses } from "../universes.js";
import { chainKey, type Resolution, type Element } from "../model.js";
import type { Diagnostic } from "../../reports/types.js";
export const DRIVING_CODES = new Set([
  "DUPLICATE_ELEMENT",
  "LOOPING_KEY",
  "MISSING_DECISION",
  "UNKNOWN_PIN_UNIVERSE",
  "NOT_BUILT_IN_UNIVERSE",
  "UNDRIVEN_DECLARATION",
  "RESULT_IN_TWO_PLACES",
  "PIN_NOT_BUILT",
]);
export function checkDriving(context: Context): Diagnostic[] {
  const found: Diagnostic[] = [],
    stack = context.stack;
  const emit = (
    code: string,
    message: string,
    entry: Resolution,
    related: readonly any[] = [],
  ) =>
    found.push(
      context.diagnostic(
        code,
        message,
        context.at(entry.file, entry.pointer, entry.key),
        related,
      ),
    );
  for (const [member, analysis] of stack.determined()) {
    const building = built(
      context.driven.get(member.identity) ?? [],
      member.identity,
    );
    for (const universe of ownUniverses(stack, member.identity)) {
      const own = context.written.get(universe) ?? [],
        selection = context.selections.get(universe),
        inherited = selection?.inherited ?? [],
        inheritedKeys = new Set(inherited.map((e) => e.key)),
        standing = new Map<Element, Resolution>();
      for (const entry of [...inherited].reverse())
        if (entry.element) standing.set(entry.element, entry);
      for (const key of own) {
        const loop = looping(key);
        if (loop)
          emit(
            "LOOPING_KEY",
            `\`${key.key}\` goes through a declaration leading back: key the decision as \`${unlooped(key)}\``,
            key,
          );
        if (!key.element) continue;
        const other = standing.get(key.element);
        if (!other) {
          standing.set(key.element, key);
          continue;
        }
        if (other !== key && !inheritedKeys.has(key.key))
          emit(
            "DUPLICATE_ELEMENT",
            `\`${key.key}\` and \`${other.key}\` spell one decision, which a universe sets under one key`,
            key,
            [context.at(other.file, other.pointer, other.key)],
          );
      }
      if (selection) {
        const written = analysis.universes[universe.id]!,
          pointer = Object.keys(written.decisions).length
            ? ["universes", universe.id, "decisions"]
            : ["universes", universe.id];
        for (const [identity, chains] of building)
          for (const id of Object.keys(stack.analysis(identity).decisions)) {
            const decision = stack.element(identity, "decision", id);
            if (
              context.used(universe).has(decision) &&
              !selection.options(decision).size
            ) {
              const spelled = [...(chains[0] ?? []).map((d) => d.id), id].join(
                ".",
              );
              found.push(
                context.diagnostic(
                  "MISSING_DECISION",
                  `\`${universe.id}\` selects nothing for \`${spelled}\`, which it uses`,
                  context.at(member.identity, pointer),
                ),
              );
            }
          }
      }
    }
  }
  for (const entry of stack.resolutions) {
    if (
      entry.pin !== undefined &&
      entry.element &&
      !Object.hasOwn(stack.analysis(entry.file).universes, entry.pin) &&
      !context.pins.get(entry)
    )
      emit(
        "UNKNOWN_PIN_UNIVERSE",
        `the pin #${entry.pin} of \`${entry.written}\` names no universe`,
        entry,
      );
    if (
      entry.pin === undefined ||
      !entry.element ||
      entry.element.kind === "input" ||
      context.onCycle(entry.element) ||
      !["inputs", "case", "artifact"].includes(entry.field)
    )
      continue;
    const universe = context.pins.get(entry);
    if (!universe || !context.selections.get(universe)) continue;
    if (context.built(entry.element, universe) === false)
      emit(
        "PIN_NOT_BUILT",
        `\`${entry.written}\` pins an output or switch that isn't built in \`${universe.id}\``,
        entry,
      );
  }
  // A pin can reach decisions its target universe doesn't use as its own driver.
  for (const pin of context.runs.get(stack.root)!.pins) {
    const universe = pin.universe,
      selection = context.selections.get(universe);
    if (!selection) continue;
    const analyses = built(
        context.driven.get(universe.analysis) ?? [],
        universe.analysis,
      ),
      used = context.used(universe),
      maybe = context.maybe(universe);
    const unset = [...pin.uses].filter(
      (d) =>
        analyses.has(d.analysis) &&
        !used.has(d) &&
        !maybe.has(d) &&
        !selection.options(d).size,
    );
    if (unset.length)
      emit(
        "PIN_NOT_BUILT",
        `\`${pin.entry.written}\` reaches decisions that \`${universe.id}\` neither sets nor uses`,
        pin.entry,
      );
  }
  const uses = new Map<Resolution, Element[]>();
  for (const [entry, universe] of context.building.reads) {
    const element = entry.element;
    if (
      !universe ||
      !element ||
      element.analysis === entry.file ||
      !context.selections.get(universe) ||
      context.onCycle(element) ||
      context.unsettledIn(universe).has(element.analysis) ||
      (entry.file === universe.analysis && context.unsettledThrough(entry))
    )
      continue;
    if (
      ["decisions", "switch"].includes(entry.field) ||
      element.kind === "switch" ||
      context.perUniverse.has(element)
    ) {
      const all = uses.get(entry) ?? [];
      if (!all.includes(universe)) all.push(universe);
      uses.set(entry, all);
    }
  }
  for (const [entry, universes] of uses) {
    const element = entry.element!;
    const missing = universes.filter(
      (u) => !context.building.universes.get(u)?.has(element.analysis),
    );
    if (missing.length)
      emit(
        "NOT_BUILT_IN_UNIVERSE",
        `\`${entry.written}\` uses another analysis where that analysis isn't built`,
        entry,
      );
    const theirs = universes.filter((u) => u.analysis === entry.file),
      driven = context.driven.get(entry.file) ?? [];
    if (
      theirs.length &&
      !driven.some((chain) => chainKey(chain) === chainKey(entry.chain))
    )
      emit(
        "UNDRIVEN_DECLARATION",
        `\`${entry.written}\` goes through a declaration this file's universes don't drive`,
        entry,
      );
  }
  const seen = new Set<string>();
  for (const planned of context.building.planned.values())
    if (planned.universe && !context.onCycle(planned.output)) {
      for (let i = 0; i < planned.chains.length; i++)
        for (let j = i + 1; j < planned.chains.length; j++) {
          const one = planned.chains[i]!,
            two = planned.chains[j]!,
            key = JSON.stringify([
              planned.output.key,
              chainKey(one),
              chainKey(two),
            ]);
          if (seen.has(key)) continue;
          seen.add(key);
          const firsts = [
            one.find((d) => !two.includes(d)),
            two.find((d) => !one.includes(d)),
          ];
          if (!firsts[0] || !firsts[1]) continue;
          for (let k = 0; k < 2; k++) {
            const first = firsts[k]!,
              other = firsts[1 - k]!;
            found.push(
              context.diagnostic(
                "RESULT_IN_TWO_PLACES",
                `the result of \`${planned.output.id}\` has two names through two driven chains`,
                context.at(first.owner, ["analyses", first.id]),
                [context.at(other.owner, ["analyses", other.id])],
              ),
            );
          }
        }
    }
  return found;
}
