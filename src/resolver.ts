/** Host-neutral ASTRA 0.1 workflows, driven by an injected repository provider. */
import type { AnalysisSource, Tree } from "./sources/types.js";
import type {
  ResolvedAnalysis,
  Result,
  StatusReport,
  ValidationReport,
} from "./reports/types.js";
import { InvalidAnalysisError } from "./errors.js";
import { validated } from "./engine/validate.js";
import {
  resolve as resolveContext,
  inputPath,
  type Resolved,
} from "./engine/resolve.js";
import { checkStatus } from "./engine/status.js";
import { places } from "./engine/universes.js";
import { look } from "./sources/standins.js";
export type {
  AnalysisSource,
  SourceProvider,
  Tree,
  Repository,
  Entry,
  EntryKind,
  FollowedFile,
  Digest,
  Declaration,
  DeclarationSource,
  DeclarationOutcome,
} from "./sources/types.js";
export async function validate(
  source: AnalysisSource,
): Promise<ValidationReport> {
  return (await validated(source.reader, source.folder, source.provider))
    .report;
}
async function read(source: AnalysisSource): Promise<Resolved> {
  const { report, context } = await validated(
    source.reader,
    source.folder,
    source.provider,
  );
  if (!report.valid || !context) throw new InvalidAnalysisError(report);
  return resolveContext(context);
}
export async function resolve(
  source: AnalysisSource,
): Promise<ResolvedAnalysis> {
  return (await read(source)).analysis;
}
export async function status(source: AnalysisSource): Promise<StatusReport> {
  return checkStatus(await read(source), source.provider);
}
async function contentBytes(
  reader: Tree,
  path: string,
): Promise<Uint8Array | undefined> {
  const found = await look(reader, path);
  if (!found.here) return undefined;
  return found.file ? found.file.read() : reader.read(path);
}
/** Read actual result content from a selected place in its worktree or commit tree. */
export async function readResult(
  source: AnalysisSource,
  resultId: string,
  placeIndex = 0,
): Promise<Uint8Array | undefined> {
  if (!Number.isSafeInteger(placeIndex) || placeIndex < 0)
    throw new RangeError("placeIndex must be a non-negative integer");
  const resolved = await read(source);
  const planned = resolved.planned.get(resultId);
  if (!planned) return undefined;
  const place = places(resolved.context.stack, planned)[placeIndex];
  if (!place) return undefined;
  return contentBytes(
    resolved.context.stack.analyses.get(planned.owner)!.reader,
    place.bytes,
  );
}
/** Available result content from one place, retaining its resolved identity. */
export interface ResultContent {
  readonly result: Result;
  readonly placeIndex: number;
  readonly bytes: Uint8Array;
}
export interface ResultReadOptions {
  /** Applied before looking up or reading content. */
  readonly filter?: (result: Result) => boolean;
}
export interface ResultResource {
  readonly result: Result;
  readonly placeIndex: number;
  read(): Promise<Uint8Array>;
  chunks(): AsyncIterable<Uint8Array>;
}
/** Resolve once and yield lazy handles for the first available place of each result.
 * Worktree content is read when a handle is consumed, not snapshotted. Custom
 * providers without chunks() fall back to a whole-file read.
 */
export async function* resultResources(
  source: AnalysisSource,
  options: ResultReadOptions = {},
): AsyncGenerator<ResultResource> {
  const resolved = await read(source);
  const stack = resolved.context.stack;
  for (const result of resolved.analysis.results) {
    if (options.filter && !options.filter(result)) continue;
    const planned = resolved.planned.get(result.id)!;
    const reader = stack.analyses.get(planned.owner)!.reader;
    const locations = places(stack, planned);
    for (let placeIndex = 0; placeIndex < locations.length; placeIndex += 1) {
      const path = locations[placeIndex]!.bytes;
      const found = await look(reader, path);
      if (!found.here) continue;
      const read = () => (found.file ? found.file.read() : reader.read(path));
      yield {
        result,
        placeIndex,
        read,
        async *chunks() {
          if (found.file?.chunks) yield* found.file.chunks();
          else if (!found.file && reader.chunks) yield* reader.chunks(path);
          else yield await read();
        },
      };
      break;
    }
  }
}
/** Stream whole files from one resolved plan; use resultResources for chunked reads. */
export async function* readResults(
  source: AnalysisSource,
  options: ResultReadOptions = {},
): AsyncGenerator<ResultContent> {
  for await (const resource of resultResources(source, options)) {
    yield {
      result: resource.result,
      placeIndex: resource.placeIndex,
      bytes: await resource.read(),
    };
  }
}
/** Read actual input content; an unfetched stand-in has no bytes to return. */
export async function readInput(
  source: AnalysisSource,
  inputRef: string,
): Promise<Uint8Array | undefined> {
  const resolved = await read(source);
  const stack = resolved.context.stack;
  for (const [identity, key] of resolved.keys) {
    for (const id of Object.keys(stack.analysis(identity).inputs)) {
      if ([key, "inputs", id].filter(Boolean).join(".") !== inputRef) continue;
      return contentBytes(
        stack.analyses.get(identity)!.reader,
        inputPath(stack, stack.element(identity, "input", id)),
      );
    }
  }
  return undefined;
}
