/** Universe inheritance, unused selections and option constraints. */
import type { Context, Selection } from "../universes.js";
import { namesOption, ownUniverses, options } from "../universes.js";
import type { Element, Resolution } from "../model.js";
import type { Diagnostic, Location } from "../../reports/types.js";
export const UNIVERSE_CODES = new Set([
  "UNKNOWN_DERIVED_FROM",
  "DERIVED_FROM_CYCLE",
  "UNUSED_DECISION",
  "INACTIVE_DECISION",
  "MISSING_REQUIRED_OPTION",
  "INCOMPATIBLE_OPTIONS",
  "EXCLUDED_OPTION_SELECTED",
]);
export function checkUniverses(context: Context): Diagnostic[] {
  const found: Diagnostic[] = [],
    stack = context.stack;
  const emit = (
    code: string,
    message: string,
    location: Location,
    related: readonly Location[] = [],
  ) => found.push(context.diagnostic(code, message, location, related));
  for (const [member, analysis] of stack.determined())
    for (const [id, universe] of Object.entries(analysis.universes))
      if (universe.derived_from !== undefined) {
        const at = context.at(member.identity, [
            "universes",
            id,
            "derived_from",
          ]),
          parent = analysis.universes[universe.derived_from];
        if (!parent || parent.analysis !== undefined)
          emit(
            "UNKNOWN_DERIVED_FROM",
            `\`${id}\` derives from \`${universe.derived_from}\`, which isn't one of this analysis's own universes`,
            at,
          );
        else {
          const chain = [id];
          while (true) {
            const next = analysis.universes[chain.at(-1)!]?.derived_from,
              entry = next === undefined ? undefined : analysis.universes[next];
            if (!next || !entry || entry.analysis !== undefined) break;
            if (next === id) {
              emit(
                "DERIVED_FROM_CYCLE",
                `\`${id}\`'s chain of derived_from loops (${[...chain, next].join(" → ")})`,
                at,
              );
              break;
            }
            if (chain.includes(next)) break;
            chain.push(next);
          }
        }
      }
  const blind = new Set(
    [...context.runs.values()].flatMap((run) => [...run.blind]),
  );
  for (const [member] of stack.determined()) {
    const run = context.runs.get(member.identity)!,
      universes = ownUniverses(stack, member.identity),
      holding = new Map<Resolution, Element[]>();
    for (const universe of universes) {
      const selection = context.selections.get(universe);
      for (const key of selection?.entries ??
        context.written.get(universe) ??
        []) {
        const own = holding.get(key) ?? [];
        own.push(universe);
        holding.set(key, own);
      }
    }
    for (const universe of universes) {
      const selection = context.selections.get(universe);
      for (const key of context.written.get(universe) ?? []) {
        const decision = key.element;
        if (!decision) continue;
        const onBranch = (holding.get(key) ?? []).some((other) =>
          run.branches.get(other)?.has(decision),
        );
        const location = context.at(key.file, key.pointer, key.key);
        if (!onBranch) {
          if (!blind.has(member.identity))
            emit(
              "UNUSED_DECISION",
              `\`${universe.id}\` sets \`${key.key}\`, which no branch of this analysis uses: remove the key`,
              location,
            );
          continue;
        }
        if (
          selection &&
          !context.used(universe).has(decision) &&
          !context.maybe(universe).has(decision)
        )
          emit(
            "INACTIVE_DECISION",
            `\`${universe.id}\` sets \`${key.key}\`, which it doesn't use`,
            location,
          );
      }
    }
  }
  const pinned = new Map<Element, Set<Element>>();
  for (const pin of context.runs.get(stack.root)!.pins) {
    const used = pinned.get(pin.universe) ?? new Set<Element>();
    for (const item of pin.uses) used.add(item);
    pinned.set(pin.universe, used);
  }
  function place(
    selection: Selection,
    entry: Resolution,
  ): [Location, Location[]] {
    const written = context.at(entry.file, entry.pointer, entry.key);
    return selection.own(entry)
      ? [written, []]
      : [
          context.at(selection.universe.analysis, [
            "universes",
            selection.universe.id,
            "derived_from",
          ]),
          [written],
        ];
  }
  for (const selection of context.selections.values())
    if (selection) {
      const universe = selection.universe,
        play = new Set([
          ...context.used(universe),
          ...(pinned.get(universe) ?? []),
        ]),
        maybe = context.maybe(universe);
      for (const entry of selection.entries) {
        if (!namesOption(stack, entry)) continue;
        const decision = entry.element!,
          option = entry.option!,
          selected = options(stack, decision)[option]!,
          [at, related] = place(selection, entry);
        const selects = `\`${universe.id}\` ${selection.own(entry) ? "selects" : "inherits"} \`${entry.key}: ${option}\``;
        if (selected.excluded !== undefined)
          emit(
            "EXCLUDED_OPTION_SELECTED",
            `${selects}, which is excluded: ${selected.excluded}`,
            at,
            related,
          );
        if (!play.has(decision) || maybe.has(decision)) continue;
        for (const constraint of stack.resolutions) {
          if (
            constraint.owner !== decision ||
            constraint.pointer[3] !== option ||
            !["requires", "incompatible_with"].includes(constraint.field) ||
            !namesOption(stack, constraint) ||
            maybe.has(constraint.element!)
          )
            continue;
          const isSelected =
            play.has(constraint.element!) &&
            selection.options(constraint.element!).has(constraint.option!);
          const location = context.at(constraint.file, constraint.pointer);
          if (constraint.field === "requires" && !isSelected)
            emit(
              "MISSING_REQUIRED_OPTION",
              `${selects}, which requires \`${constraint.written}\`, and it isn't selected`,
              at,
              [...related, location],
            );
          if (constraint.field === "incompatible_with" && isSelected)
            emit(
              "INCOMPATIBLE_OPTIONS",
              `${selects}, which is incompatible with \`${constraint.written}\`, selected too`,
              at,
              [...related, location],
            );
        }
      }
    }
  return found;
}
