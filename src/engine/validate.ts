/** Validate every document and semantic rule in one analysis stack. */
import type { Tree, SourceProvider } from "../sources/types.js";
import type {
  Diagnostic,
  Location,
  ValidationReport,
} from "../reports/types.js";
import { VALIDATION_REPORT_SCHEMA_VERSION } from "../reports/types.js";
import { bind } from "./stack.js";
import { Context } from "./universes.js";
import { diagnostic, rules } from "./documents.js";
import type { Declaration, Identity, Stack } from "./model.js";
import { checkBasic, BASIC_CODES } from "./rules/basic.js";
import { checkInputs, INPUT_CODES } from "./rules/inputs.js";
import { checkUniverses, UNIVERSE_CODES } from "./rules/universes.js";
import { checkDriving, DRIVING_CODES } from "./rules/driving.js";

export interface Validated {
  readonly report: ValidationReport;
  readonly context?: Context;
}
const COMMIT_CODES = new Set([
  "COMMIT_NOT_FOUND",
  "COMMIT_NOT_ANCESTOR",
  "REMOTE_UNREACHABLE",
  "DECLARED_ANALYSIS_INVALID",
]);
const checked = new Set([
  ...BASIC_CODES,
  ...INPUT_CODES,
  ...UNIVERSE_CODES,
  ...DRIVING_CODES,
  ...COMMIT_CODES,
  "NOT_IN_REPOSITORY",
  "UNSUPPORTED_SPEC_VERSION",
]);
function unchecked(): string[] {
  return [...rules.values()]
    .filter((rule) => rule.layer === "validator" && !checked.has(rule.code))
    .map((rule) => rule.code);
}
function locationKey(at: Location): unknown[] {
  return [
    at.file,
    at.pointer,
    at.line ?? null,
    at.column ?? null,
    at.key ?? null,
    at.commit ?? null,
    at.url ?? null,
  ];
}
function diagnosticKey(d: Diagnostic): string {
  return JSON.stringify([
    d.code,
    d.level,
    d.message,
    locationKey(d.location),
    d.related.map(locationKey),
  ]);
}
function compare(a: Diagnostic, b: Diagnostic): number {
  const x = a.location,
    y = b.location;
  for (const [one, two] of [
    [x.commit === undefined ? 0 : 1, y.commit === undefined ? 0 : 1],
    [x.commit ?? "", y.commit ?? ""],
    [x.file, y.file],
    [x.line ?? 0, y.line ?? 0],
    [x.column ?? 0, y.column ?? 0],
    [a.code, b.code],
  ] as const) {
    if (one < two) return -1;
    if (one > two) return 1;
  }
  return 0;
}
function through(stack: Stack, declaration: Declaration): Identity[] {
  const found = new Set<Identity>(),
    todo = declaration.reached ? [declaration.reached] : [];
  while (todo.length) {
    const id = todo.pop()!;
    if (found.has(id)) continue;
    found.add(id);
    for (const inner of stack.analyses.get(id)?.declarations.values() ?? [])
      if (inner.reached) todo.push(inner.reached);
  }
  return [...found];
}
function unreachable(
  stack: Stack,
  declaration: Declaration,
): (readonly [string | undefined, string])[] {
  const found = new Map<string, readonly [string | undefined, string]>();
  if (declaration.unreachable)
    found.set(JSON.stringify(declaration.unreachable), declaration.unreachable);
  for (const identity of through(stack, declaration))
    for (const inner of stack.analyses.get(identity)?.declarations.values() ??
      [])
      if (inner.unreachable)
        found.set(JSON.stringify(inner.unreachable), inner.unreachable);
  return [...found.values()];
}

export async function validated(
  reader: Tree,
  folder: string,
  provider: SourceProvider,
): Promise<Validated> {
  const cached = new Map<string, Validated>(),
    active = new Set<string>();
  async function judge(reader: Tree, folder: string): Promise<Validated> {
    const key = JSON.stringify([reader.id, folder]),
      file = folder ? `${folder}/astra.yaml` : "astra.yaml";
    const held = cached.get(key);
    if (held) return held;
    if (active.has(key))
      return {
        report: {
          root: file,
          valid: true,
          diagnostics: [],
          unchecked: [],
          schema_version: VALIDATION_REPORT_SCHEMA_VERSION,
        },
      };
    active.add(key);
    const loaded = await bind(reader, folder, provider),
      found = [...loaded.diagnostics];
    let context: Context | undefined;
    if (!reader.repo)
      found.push(
        diagnostic(
          "NOT_IN_REPOSITORY",
          "the analysis's folder isn't in the working tree of a git repository: make one with git init, or move the analysis into one",
          { file, pointer: "" },
        ),
      );
    else if (loaded.stack) {
      context = new Context(loaded.stack);
      const own = [
        ...checkBasic(context),
        ...(await checkInputs(context)),
        ...checkUniverses(context),
        ...checkDriving(context),
      ];
      const commitFound = await checkCommits(context, judge);
      const judgedKeys = new Set(commitFound.map(diagnosticKey));
      const leading = new Map<string, Location[]>();
      for (const [member] of context.stack.determined())
        if (member.identity.commit === context.stack.root.commit)
          for (const declaration of member.declarations.values())
            if (declaration.declared.commit !== undefined) {
              const at = context.at(member.identity, [
                "analyses",
                declaration.id,
              ]);
              for (const identity of through(context.stack, declaration)) {
                const inner = context.stack.analyses.get(identity)!,
                  key = JSON.stringify([inner.file, identity.commit]);
                const places = leading.get(key) ?? [];
                places.push(at);
                leading.set(key, places);
              }
            }
      for (const item of own) {
        const related = leading.get(
          JSON.stringify([item.location.file, item.location.commit]),
        );
        found.push(
          item.level === "error" &&
            related?.length &&
            !judgedKeys.has(diagnosticKey(item))
            ? { ...item, related: [...item.related, ...related] }
            : item,
        );
      }
      found.push(...commitFound);
    }
    const diagnostics = [
      ...new Map(found.map((d) => [diagnosticKey(d), d])).values(),
    ].sort(compare);
    const report: ValidationReport = {
      root: file,
      valid: diagnostics.every((d) => d.level !== "error"),
      diagnostics,
      unchecked: unchecked(),
      schema_version: VALIDATION_REPORT_SCHEMA_VERSION,
    };
    const result = { report, ...(context ? { context } : {}) };
    active.delete(key);
    cached.set(key, result);
    return result;
  }
  return judge(reader, folder);
}
async function checkCommits(
  context: Context,
  judge: (reader: Tree, folder: string) => Promise<Validated>,
): Promise<Diagnostic[]> {
  const out: Diagnostic[] = [],
    stack = context.stack;
  for (const [member] of stack.determined())
    for (const declaration of member.declarations.values()) {
      const declared = declaration.declared;
      if (declared.commit === undefined) continue;
      if (declaration.outcome === "absent") {
        out.push(
          context.diagnostic(
            "COMMIT_NOT_FOUND",
            `the repository that holds this file has no commit \`${declared.commit}\``,
            context.at(member.identity, ["analyses", declaration.id, "commit"]),
          ),
        );
        continue;
      }
      const got = declaration.unreachable?.[1] !== declared.commit;
      if (declared.path !== undefined && got) {
        const { repository } = await member.reader.holding(
          member.identity.folder,
        );
        const descendant = member.identity.commit ?? (await repository.head());
        if (
          descendant &&
          !(await repository.isAncestor(declared.commit, descendant))
        )
          out.push(
            context.diagnostic(
              "COMMIT_NOT_ANCESTOR",
              `\`${declared.commit}\` isn't an ancestor of ${member.identity.commit === undefined ? "HEAD" : "the commit this file is in"}, \`${descendant}\``,
              context.at(member.identity, [
                "analyses",
                declaration.id,
                "commit",
              ]),
            ),
          );
      }
      const missing = unreachable(stack, declaration);
      if (member.identity.commit === stack.root.commit)
        for (const [url, commit] of missing)
          out.push(
            context.diagnostic(
              "REMOTE_UNREACHABLE",
              `the commit \`${commit}\` can't be fetched from \`${url ?? "a submodule with no URL"}\``,
              context.at(member.identity, ["analyses", declaration.id]),
            ),
          );
      if (missing.length || !declaration.reached) continue;
      const inner = stack.analyses.get(declaration.reached)!;
      const result = await judge(inner.reader, inner.identity.folder);
      if (
        result.report.diagnostics.some(
          (d) =>
            d.code === "UNSUPPORTED_SPEC_VERSION" &&
            d.location.file === inner.file &&
            d.location.commit === inner.identity.commit,
        )
      )
        continue;
      const broken = result.report.diagnostics.filter(
        (d) => d.level === "error",
      );
      if (broken.length) {
        out.push(
          context.diagnostic(
            "DECLARED_ANALYSIS_INVALID",
            `\`${declaration.id}\` names an analysis that isn't valid at its commit: it breaks ${[...new Set(broken.map((d) => d.code))].sort().join(", ")}`,
            context.at(member.identity, ["analyses", declaration.id]),
            broken.map((d) => d.location),
          ),
        );
        out.push(...broken);
      }
    }
  return out;
}
export async function validate(
  reader: Tree,
  folder: string,
  provider: SourceProvider,
): Promise<ValidationReport> {
  return (await validated(reader, folder, provider)).report;
}
