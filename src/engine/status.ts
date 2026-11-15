/** Native provenance checking. Record state and content availability are independent. */
import type {
  Bytes,
  Diagnostic,
  EvidenceStatus,
  Location,
  ProvenanceRecord,
  Result,
  Status,
  StatusReport,
} from "../reports/types.js";
import { STATUS_REPORT_SCHEMA_VERSION } from "../reports/types.js";
import type { Digest, SourceProvider } from "../sources/types.js";
import { look, content, type Found } from "../sources/standins.js";
import { checkRecordDocument, diagnostic } from "./documents.js";
import type { Element, Identity, Member } from "./model.js";
import { bind } from "./stack.js";
import {
  Context,
  places,
  type Planned,
  type Place,
  type Selection,
  type Through,
  type Step,
} from "./universes.js";
import { reads, inputPath, selected, type Resolved } from "./resolve.js";

type State = Status["state"];
const worst = (states: Iterable<State>): State => {
  const found = new Set(states);
  return found.has("missing")
    ? "missing"
    : found.has("stale")
      ? "stale"
      : found.has("unchanged")
        ? "unchanged"
        : "missing";
};
const sameDigest = (a: Digest | undefined, b: Digest | undefined): boolean =>
  a !== undefined &&
  b !== undefined &&
  a.content_hash === b.content_hash &&
  a.size === b.size;
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const listed = (items: readonly string[]): string =>
  items.length ? `[${items.map((x) => `\`${x}\``).join(", ")}]` : "none";
const option = (value: string | undefined): string =>
  value === undefined ? "nothing" : `\`${value}\``;
const location = (member: Member, path: string): Location => ({
  file: path,
  pointer: "",
  ...(member.identity.commit !== undefined
    ? { commit: member.identity.commit }
    : {}),
  ...(member.url !== undefined ? { url: member.url } : {}),
});

interface Then {
  context: Context;
  output: Element;
  universe?: Element;
  selection?: Selection;
}

/** Every result is checked after the results it reads, as ordered by resolve. */
export async function checkStatus(
  resolved: Resolved,
  provider: SourceProvider,
): Promise<StatusReport> {
  const checker = new Checker(resolved, provider);
  const statuses: Record<string, Status> = Object.create(null);
  const read = new Set(
    resolved.analysis.results.flatMap((r) =>
      r.inputs.flatMap((s) => (s.result === undefined ? [] : [s.result])),
    ),
  );
  for (const result of resolved.analysis.results) {
    const planned = resolved.planned.get(result.id)!;
    const each: Status[] = [];
    for (const place of places(resolved.context.stack, planned)) {
      each.push(
        await checker.place(
          result,
          planned,
          place,
          statuses,
          planned.owner.commit === undefined || read.has(result.id),
        ),
      );
    }
    const held = each.flatMap((s) => (s.bytes === undefined ? [] : [s.bytes]));
    const bytes = held.find((b) => b.state === "absent") ?? held[0];
    statuses[result.id] = {
      state: worst(each.map((s) => s.state)),
      ...(bytes === undefined ? {} : { bytes }),
      ...(each.length && each.every((s) => s.record !== undefined)
        ? { record: each[0]!.record! }
        : {}),
      why: each.flatMap((s) => s.why),
      stale_inputs: [...new Set(each.flatMap((s) => s.stale_inputs))],
    };
  }
  const evidence: EvidenceStatus[] = [];
  for (const analysis of resolved.analysis.analyses) {
    const identity = [...resolved.keys].find(
      ([, key]) => key === analysis.key,
    )![0];
    for (const insight of [...analysis.prior_insights, ...analysis.findings]) {
      for (const [index, item] of insight.evidence.entries()) {
        if (
          item.cites === undefined ||
          (analysis.key !== "" && item.cites.length === 0)
        )
          continue;
        const state = worst(item.cites.map((id) => statuses[id]!.state));
        const collection =
          insight.kind === "finding" ? "findings" : "prior_insights";
        const id = insight.ref.slice(insight.ref.lastIndexOf(".") + 1);
        const what = item.cites.length
          ? `cites ${item.cites.map((x) => `\`${x}\``).join(", ")}: ${item.cites.length === 1 ? "it is" : "one of them is"} ${state}`
          : "cites no result: none is planned for it in a universe of the root";
        evidence.push({
          insight: insight.ref,
          index,
          state,
          why:
            state === "unchanged"
              ? []
              : [
                  diagnostic(
                    "STALE_EVIDENCE",
                    `the evidence ${what}`,
                    resolved.context.at(identity, [
                      collection,
                      id,
                      "evidence",
                      index,
                      "artifact",
                    ]),
                  ),
                ],
        });
      }
    }
  }
  const inputs: Record<string, Bytes> = Object.create(null);
  for (const [identity, key] of [...resolved.keys].sort((a, b) =>
    a[1].localeCompare(b[1]),
  )) {
    const analysis = resolved.context.stack.analysis(identity);
    for (const id of Object.keys(analysis.inputs)) {
      const element = resolved.context.stack.element(identity, "input", id);
      const [found] = await checker.look(
        identity,
        inputPath(resolved.context.stack, element),
      );
      inputs[[key, "inputs", id].filter(Boolean).join(".")] = byteState(
        found.here,
        found.kept_by,
      );
    }
  }
  return {
    ...(resolved.analysis.head === undefined
      ? {}
      : { head: resolved.analysis.head }),
    statuses,
    evidence,
    inputs,
    schema_version: STATUS_REPORT_SCHEMA_VERSION,
  };
}

const byteState = (here: boolean, kept?: string): Bytes => ({
  state: here ? "present" : "absent",
  ...(kept === undefined ? {} : { kept_by: kept }),
});

class Checker {
  readonly context: Context;
  private readonly bound = new Map<string, Promise<Context | string>>();
  private readonly found = new Map<
    string,
    Promise<readonly [Found, Digest | undefined]>
  >();
  constructor(
    readonly resolved: Resolved,
    readonly provider: SourceProvider,
  ) {
    this.context = resolved.context;
  }

  look(
    identity: Identity,
    path: string,
  ): Promise<readonly [Found, Digest | undefined]> {
    const key = JSON.stringify([identity.key, path]);
    let result = this.found.get(key);
    if (!result) {
      result = (async () => {
        const reader = this.context.stack.analyses.get(identity)!.reader;
        const found = await look(reader, path);
        return [found, await content(reader, path, found)] as const;
      })();
      this.found.set(key, result);
    }
    return result;
  }

  async place(
    result: Result,
    planned: Planned,
    place: Place,
    statuses: Readonly<Record<string, Status>>,
    hasBytes: boolean,
  ): Promise<Status> {
    const member = this.context.stack.analyses.get(planned.owner)!;
    const at = location(member, place.record);
    const why: Diagnostic[] = [];
    let state: State = "missing",
      record: ProvenanceRecord | undefined;
    let stale: string[] = [];
    const entry = await member.reader.stat(place.record);
    if (!entry || entry.kind !== "file") {
      why.push(
        diagnostic(
          "MISSING_RECORD",
          `no record is at ${place.record}: build \`${place.address}\`, and record it there`,
          at,
        ),
      );
    } else {
      const checked = checkRecordDocument(
        await member.reader.read(place.record),
        place.record,
        member.identity.commit,
        member.url,
      );
      if (checked.diagnostics.length) {
        for (const broken of checked.diagnostics)
          why.push(
            diagnostic(
              "INVALID_RECORD",
              `${broken.message}${broken.code === "INVALID_RECORD" ? "" : ` (${broken.code})`}`,
              broken.location,
            ),
          );
      } else {
        const raw = checked.document!.value as Record<string, any>;
        const run = raw.generated_by;
        const found: ProvenanceRecord = {
          address: raw.address,
          content_hash: raw.content_hash,
          size: raw.size,
          spec_version: raw.spec_version,
          generated_by: {
            commit: run.commit,
            environment: { iri: run.environment.iri },
            runner: { id: run.runner.id, version: run.runner.version },
            inputs: (run.inputs ?? []).map((item: any) => ({
              entry: item.entry,
              content_hash: item.content_hash,
              size: item.size,
            })),
            ...(run.started === undefined ? {} : { started: run.started }),
            ...(run.finished === undefined ? {} : { finished: run.finished }),
          },
        };
        if (found.address !== place.address)
          why.push(
            diagnostic(
              "MISPLACED_RECORD",
              `the record's address is \`${found.address}\`, where this place is \`${place.address}\`'s: a record is the record only of the result it names`,
              at,
            ),
          );
        const then = await this.then(planned, place, found);
        let changes: string[] = [];
        if (typeof then === "string") changes = [then];
        else {
          why.push(...this.recordInputs(found, then, at));
          if (!why.length)
            [changes, stale] = await this.changes(
              result,
              planned,
              found,
              then,
              statuses,
            );
        }
        if (!why.length) {
          why.push(
            ...changes.map((message) =>
              diagnostic("STALE_RESULT", message, at),
            ),
          );
          state = changes.length || stale.length ? "stale" : "unchanged";
          record = found;
        }
      }
    }
    let bytes: Bytes | undefined;
    if (hasBytes) {
      const [found, digest] = await this.look(member.identity, place.bytes);
      bytes = byteState(
        record !== undefined && sameDigest(digest, record) && found.here,
        found.kept_by,
      );
      if (
        record &&
        !sameDigest(digest, record) &&
        !(digest === undefined && found.standin !== undefined)
      ) {
        const message = found.here
          ? `the bytes at ${place.bytes} aren't the ones its record gives`
          : found.standin
            ? `the ${found.standin.name} stand-in at ${place.bytes} is for other bytes than the ones its record gives`
            : `no file is at ${place.bytes}, the result's default place`;
        why.push(
          diagnostic("ABSENT_RESULT", message, location(member, place.bytes)),
        );
      }
    }
    return {
      state,
      ...(bytes === undefined ? {} : { bytes }),
      ...(record === undefined ? {} : { record }),
      why,
      stale_inputs: stale,
    };
  }

  private async then(
    planned: Planned,
    place: Place,
    record: ProvenanceRecord,
  ): Promise<Then | string> {
    const member = this.context.stack.analyses.get(planned.owner)!;
    const { repository, folder } = await member.reader.holding(
      member.identity.folder,
    );
    const commit = record.generated_by.commit;
    const key = JSON.stringify([repository.top, commit, folder]);
    let bound = this.bound.get(key);
    if (!bound) {
      bound = (async () => {
        const historical =
          member.url === undefined
            ? (await repository.hasCommit(commit))
              ? repository
              : undefined
            : await this.provider.remote(member.url, commit);
        if (!historical)
          return `the record names the commit \`${commit}\`, which ${member.url === undefined ? "the repository that holds its analysis" : `\`${member.url}\``} hasn't, so what the result was made from can't be compared`;
        const reader = await this.provider.atCommit(
          historical,
          commit,
          member.url,
        );
        const file = folder ? `${folder}/astra.yaml` : "astra.yaml";
        if ((await reader.stat(file))?.kind === "file") {
          const { stack } = await bind(reader, folder, this.provider);
          if (stack) return new Context(stack);
        }
        return `at ${commit.slice(0, 12)}, the commit the record names, ${file} isn't a valid astra.yaml, so what the result was made from can't be compared`;
      })();
      this.bound.set(key, bound);
    }
    const context = await bound;
    if (typeof context === "string") return context;
    const output = context.stack.resolveElement(place.name, "output");
    if (!output)
      return `at ${commit.slice(0, 12)}, the commit the record names, \`${place.name}\` names no output, so what the result was made from can't be compared`;
    const universe =
      planned.universe === undefined
        ? undefined
        : context.stack.element(
            context.stack.root,
            "universe",
            planned.universe.id,
          );
    return {
      context,
      output,
      ...(universe === undefined
        ? {}
        : { universe, selection: context.selections.get(universe) }),
    };
  }

  private recordInputs(
    record: ProvenanceRecord,
    then: Then,
    at: Location,
  ): Diagnostic[] {
    const entries = then.context.stack.analysis(then.output.analysis).outputs[
      then.output.id
    ]!.inputs;
    const items = record.generated_by.inputs.map((item) => item.entry);
    const commit = record.generated_by.commit.slice(0, 12);
    const messages = entries
      .filter((entry) => !items.includes(entry))
      .map(
        (entry) =>
          `the record has no item for \`${entry}\`, which its output lists at ${commit}`,
      );
    for (const entry of new Set(items)) {
      if (!entries.includes(entry))
        messages.push(
          `the record has an item for \`${entry}\`, which its output doesn't list at ${commit}`,
        );
      else if (items.filter((item) => item === entry).length > 1)
        messages.push(
          `the record has ${items.filter((item) => item === entry).length} items for \`${entry}\`, not one`,
        );
    }
    return messages.map((message) =>
      diagnostic("MISSING_RECORD_INPUTS", message, at),
    );
  }

  private async changes(
    result: Result,
    planned: Planned,
    record: ProvenanceRecord,
    then: Then,
    statuses: Readonly<Record<string, Status>>,
  ): Promise<[string[], string[]]> {
    const now = this.context.stack.analysis(planned.output.analysis).outputs[
      planned.output.id
    ]!;
    const was = then.context.stack.analysis(then.output.analysis).outputs[
      then.output.id
    ]!;
    const commit = record.generated_by.commit.slice(0, 12);
    const changes: string[] = [],
      stale: string[] = [];
    if (now.recipe?.command !== was.recipe?.command)
      changes.push(`its recipe's command isn't the one it had at ${commit}`);
    if (!same(now.inputs, was.inputs))
      changes.push(
        `its inputs are ${listed(now.inputs)}, in that order, where they were ${listed(was.inputs)} at ${commit}`,
      );
    if (
      !same(
        [...new Set(now.decisions)].sort(),
        [...new Set(was.decisions)].sort(),
      )
    )
      changes.push(
        `its decisions are ${listed(now.decisions)}, where they were ${listed(was.decisions)} at ${commit}`,
      );
    if (now.format !== was.format)
      changes.push(
        `its format is \`${now.format}\`, where it was \`${was.format}\` at ${commit}`,
      );
    const selection =
      planned.universe === undefined
        ? undefined
        : this.context.selections.get(planned.universe);
    const before = selected(
      then.context.written.get(then.output) ?? [],
      then.selection,
    );
    for (const [written, choice] of Object.entries(
      selected(this.context.written.get(planned.output) ?? [], selection),
    )) {
      if (Object.hasOwn(before, written) && before[written] !== choice)
        changes.push(
          `\`${written}\` selects ${option(choice)} in \`${planned.universe!.id}\`, where it selected ${option(before[written])} at ${commit}`,
        );
    }
    const recorded = new Map(
      record.generated_by.inputs.map((item) => [item.entry, item]),
    );
    const listedThen = new Map(
      (then.context.written.get(then.output) ?? [])
        .filter((entry) => entry.field === "inputs")
        .map((entry) => [entry.written, entry]),
    );
    const currentReads = reads(this.context, planned);
    for (let index = 0; index < currentReads.length; index++) {
      const [entry, through] = currentReads[index]!;
      const source = result.inputs[index]!,
        item = recorded.get(source.entry);
      if (!item) continue;
      const earlier = listedThen.get(entry.written);
      const readThen =
        earlier === undefined
          ? undefined
          : then.context.meaning.through(earlier, then.universe);
      changes.push(
        ...switched(
          source.entry,
          through,
          readThen,
          this.context,
          then.context,
          commit,
        ),
      );
      if (source.result === undefined) {
        const path = inputPath(this.context.stack, through.target);
        const [, found] = await this.look(through.target.analysis, path);
        if (!found)
          changes.push(
            `the content of \`${source.entry}\` can't be read at ${path}: no file is there, or only a stand-in that gives no SHA-256`,
          );
        else if (!sameDigest(found, item))
          changes.push(
            `the content of \`${source.entry}\`, ${path}, isn't what the recipe read`,
          );
      } else {
        const status = statuses[source.result]!;
        if (
          status.state !== "unchanged" ||
          (status.record !== undefined && !sameDigest(status.record, item))
        )
          stale.push(source.entry);
      }
    }
    return [changes, stale];
  }
}

function switched(
  entry: string,
  now: Through,
  then: Through | undefined,
  here: Context,
  was: Context,
  commit: string,
): string[] {
  const switches = (steps: readonly Step[]): string =>
    steps.map((step) => `\`${step.switch.id}\``).join(" then ") || "no switch";
  if (!then)
    return now.steps.length
      ? [
          `\`${entry}\` reads through ${switches(now.steps)}, where what it read at ${commit} isn't determined there`,
        ]
      : [];
  const other = `\`${entry}\` reads through ${switches(now.steps)}, where it read through ${switches(then.steps)} at ${commit}`;
  const changes: string[] = [];
  for (
    let index = 0;
    index < Math.min(now.steps.length, then.steps.length);
    index++
  ) {
    const step = now.steps[index]!,
      before = then.steps[index]!;
    if (
      step.switch.analysis.folder !== before.switch.analysis.folder ||
      step.switch.id !== before.switch.id
    )
      return [...changes, other];
    const decision = here.stack.switches.get(step.switch)!.decision.written;
    const earlier = was.stack.switches.get(before.switch)!.decision.written;
    if (decision !== earlier)
      return [
        ...changes,
        `\`${step.switch.id}\` switches on \`${decision}\`, where it switched on \`${earlier}\` at ${commit}`,
      ];
    if (step.option !== before.option)
      changes.push(
        `\`${step.switch.id}\` switches on \`${decision}\`, which selects \`${step.option}\` in \`${step.universe.id}\`, where it selected \`${before.option}\` at ${commit}`,
      );
    else if (step.case.written !== before.case.written)
      changes.push(
        `\`${step.switch.id}\`'s case for \`${step.option}\` is \`${step.case.written}\`, where it was \`${before.case.written}\` at ${commit}`,
      );
    if (step.case.written !== before.case.written) return changes;
  }
  if (now.steps.length !== then.steps.length) changes.push(other);
  return changes;
}
