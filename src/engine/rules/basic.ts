/** Reference, option, output, declaration, template and insight rules. */
import type { Context } from "../universes.js";
import { options } from "../universes.js";
import { TAKES, type Element, type Resolution } from "../model.js";
import type { Diagnostic } from "../../reports/types.js";

export const BASIC_CODES = new Set([
  "UNRESOLVED_ADDRESS",
  "UNKNOWN_OPTION",
  "AMBIGUOUS_ID",
  "OUTPUT_CYCLE",
  "DECLARATION_OUTSIDE_REPOSITORY",
  "MISSING_DECLARED_ANALYSIS",
  "CLASHING_RESULT_NAME",
  "INVALID_INSIGHT_REF",
  "UNDECLARED_TEMPLATE_REF",
]);
export function checkBasic(context: Context): Diagnostic[] {
  const out: Diagnostic[] = [],
    stack = context.stack;
  const emit = (
    code: string,
    message: string,
    file: Resolution["file"],
    pointer: readonly (string | number)[],
    key?: string,
    related: readonly any[] = [],
  ) =>
    out.push(
      context.diagnostic(
        code,
        message,
        context.at(file, pointer, key),
        related,
      ),
    );
  function ambiguous(entry: Resolution): boolean {
    if (
      !["inputs", "case"].includes(entry.field) ||
      entry.chain.length < entry.address.declarations.length
    )
      return false;
    const reached = entry.chain.at(-1)?.reached ?? entry.file;
    const analysis = stack.analyses.get(reached)?.analysis;
    return (
      !!analysis &&
      Object.hasOwn(analysis.inputs, entry.address.id) &&
      Object.hasOwn(analysis.outputs, entry.address.id)
    );
  }
  function inputCase(switch_: Element): Resolution | undefined {
    const found: Resolution[] = [],
      seen = new Set<Element>(),
      path = new Set<Element>();
    function walk(at: Element): boolean {
      if (path.has(at) || context.onCycle(at)) return false;
      if (seen.has(at)) return true;
      path.add(at);
      for (const entry of stack.switches.get(at)?.cases.values() ?? []) {
        const target = entry.element;
        if (!target) return false;
        if (target.kind === "input") found.push(entry);
        else if (target.kind === "switch" && !walk(target)) return false;
      }
      path.delete(at);
      seen.add(at);
      return true;
    }
    return walk(switch_) ? found[0] : undefined;
  }
  for (const entry of stack.resolutions) {
    if (!entry.element && !entry.undetermined && !ambiguous(entry)) {
      const { address, chain } = entry;
      let pointer = entry.pointer,
        detail: string;
      const through = address.segments.slice(0, chain.length).join(".");
      if (chain.length < address.declarations.length) {
        detail = `${through ? `\`${through}\` declares` : "this file declares"} no analysis \`${address.declarations[chain.length]}\``;
        if (entry.field === "import") pointer = [...pointer, "analysis"];
      } else if (
        entry.field === "import" &&
        (chain.at(-1)?.reached ?? entry.file) === entry.file
      ) {
        detail = `an import names a universe of another analysis, and \`${through}\` leads back to this one: a pin names this analysis's own universes without one`;
        pointer = [...pointer, "analysis"];
      } else {
        const kind = TAKES[entry.field]
          .filter((k) => k !== "switch")
          .join(" or ");
        detail = `${through ? `\`${through}\`` : "this analysis"} has no ${kind} \`${address.id}\``;
        if (entry.field === "import") pointer = [...pointer, "universe"];
      }
      emit(
        "UNRESOLVED_ADDRESS",
        `\`${entry.written}\` names nothing: ${detail}`,
        entry.file,
        pointer,
        entry.key,
      );
    } else if (entry.field === "artifact" && entry.element?.kind === "switch") {
      const wrong = inputCase(entry.element);
      if (wrong)
        emit(
          "UNRESOLVED_ADDRESS",
          `\`${entry.written}\` names a switch whose case \`${wrong.written}\` names an input: evidence cites outputs`,
          entry.file,
          entry.pointer,
          undefined,
          [context.at(wrong.file, wrong.pointer)],
        );
    }
    if (entry.option !== undefined) {
      let decision = entry,
        pointer = entry.pointer,
        key: string | undefined;
      if (entry.field === "case") {
        decision = stack.switches.get(entry.owner!)!.decision;
        pointer = pointer.slice(0, -1);
        key = entry.option;
      } else if (entry.key !== undefined) pointer = [...pointer, entry.key];
      if (
        decision.element &&
        !Object.hasOwn(options(stack, decision.element), entry.option)
      )
        emit(
          "UNKNOWN_OPTION",
          `\`${decision.address.segments.join(".")}\` has no option \`${entry.option}\`: its options are ${Object.keys(
            options(stack, decision.element),
          )
            .map((id) => `\`${id}\``)
            .join(", ")}`,
          entry.file,
          pointer,
          key,
        );
    }
  }
  for (const [member, analysis] of stack.determined()) {
    for (const declaration of member.declarations.values()) {
      const field = declaration.declared.path === undefined ? "url" : "path",
        at = ["analyses", declaration.id, field];
      if (
        declaration.declared.path !== undefined &&
        declaration.folder === undefined
      )
        emit(
          "DECLARATION_OUTSIDE_REPOSITORY",
          `\`${declaration.declared.path}\` goes above the top of the repository`,
          member.identity,
          at,
        );
      else if (declaration.outcome === "missing")
        emit(
          "MISSING_DECLARED_ANALYSIS",
          `the folder \`${declaration.folder || "."}\` holds no astra.yaml file (a symlink, or a path through one, is never followed)`,
          member.identity,
          at,
        );
    }
    for (const id of Object.keys(analysis.outputs)) {
      if (Object.hasOwn(analysis.inputs, id))
        emit(
          "AMBIGUOUS_ID",
          `the input and the output \`${id}\` share an id, and Output.inputs takes both: rename one`,
          member.identity,
          ["outputs"],
          id,
          [context.at(member.identity, ["inputs"], id)],
        );
      if (Object.hasOwn(analysis.analyses, id))
        emit(
          "CLASHING_RESULT_NAME",
          `the output \`${id}\` shares its id with a declaration`,
          member.identity,
          ["outputs"],
          id,
          [context.at(member.identity, ["analyses"], id)],
        );
      const output = analysis.outputs[id]!;
      if (output.switch !== undefined || !output.recipe) continue;
      for (const match of output.recipe.command.matchAll(
        /\{\{|\}\}|\{[^}]*\}|\{|\}/g,
      )) {
        const text = match[0],
          at = match.index + 1;
        let problem: string | undefined;
        if (text === "}")
          problem = `the } at character ${at} ends no placeholder: write }} for }`;
        else if (text === "{")
          problem = `the { at character ${at} opens a placeholder that never ends`;
        else if (text !== "{{" && text !== "}}") {
          const inner = text.slice(1, -1),
            dot = inner.indexOf("."),
            field = inner.slice(0, dot),
            entry = inner.slice(dot + 1);
          if (
            inner !== "inputs" &&
            inner !== "output" &&
            !(
              dot >= 0 &&
              (field === "inputs"
                ? output.inputs.includes(entry)
                : field === "decisions" && output.decisions.includes(entry))
            )
          )
            problem = `\`${text}\` isn't a placeholder of this output`;
        }
        if (problem)
          emit("UNDECLARED_TEMPLATE_REF", problem, member.identity, [
            "outputs",
            id,
            "recipe",
            "command",
          ]);
        if (text === "{") break;
      }
    }
    for (const [decisionId, decision] of Object.entries(analysis.decisions))
      for (const [optionId, option] of Object.entries(decision.options))
        for (const [i, id] of option.insights.entries())
          if (!Object.hasOwn(analysis.prior_insights, id))
            emit(
              "INVALID_INSIGHT_REF",
              `\`${id}\` names no prior insight`,
              member.identity,
              ["decisions", decisionId, "options", optionId, "insights", i],
            );
  }
  const graph = new Map<Element, Element[]>();
  for (const [owner, entries] of context.depends)
    graph.set(
      owner,
      entries.map(([target]) => target),
    );
  function back(start: Element, end: Element): boolean {
    const seen = new Set<Element>(),
      todo = [start];
    while (todo.length) {
      const at = todo.shift()!;
      if (at === end) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      todo.push(...(graph.get(at) ?? []));
    }
    return false;
  }
  for (const [owner, entries] of context.depends)
    for (const [target, entry] of entries)
      if (back(target, owner))
        emit(
          "OUTPUT_CYCLE",
          `\`${owner.id}\` depends on itself through \`${entry.written}\``,
          entry.file,
          entry.pointer,
        );
  return out;
}
