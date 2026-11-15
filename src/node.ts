/** Native filesystem/Git adapters. No Python executable or package is used. */
import { NodeSourceProvider, type NodeSourceOptions } from "./sources/node.js";
import * as engine from "./resolver.js";
import type {
  ResolvedAnalysis,
  StatusReport,
  ValidationReport,
} from "./reports/types.js";
export { NodeSourceProvider } from "./sources/node.js";
export type { NodeSourceOptions } from "./sources/node.js";
export type {
  ResultContent,
  ResultResource,
  ResultReadOptions,
} from "./resolver.js";
export {
  CacheError,
  GitError,
  NoAnalysisError,
  InvalidAnalysisError,
} from "./errors.js";
export async function validate(
  path?: string,
  options: NodeSourceOptions = {},
): Promise<ValidationReport> {
  const provider = new NodeSourceProvider(options);
  return engine.validate(await provider.worktree(path));
}
export async function resolve(
  path?: string,
  options: NodeSourceOptions = {},
): Promise<ResolvedAnalysis> {
  const provider = new NodeSourceProvider(options);
  return engine.resolve(await provider.worktree(path));
}
export async function status(
  path?: string,
  options: NodeSourceOptions = {},
): Promise<StatusReport> {
  const provider = new NodeSourceProvider(options);
  return engine.status(await provider.worktree(path));
}
export async function readResult(
  path: string,
  resultId: string,
  options: NodeSourceOptions & { readonly placeIndex?: number } = {},
): Promise<Uint8Array | undefined> {
  const provider = new NodeSourceProvider(options);
  return engine.readResult(
    await provider.worktree(path),
    resultId,
    options.placeIndex,
  );
}
export async function readInput(
  path: string,
  inputRef: string,
  options: NodeSourceOptions = {},
): Promise<Uint8Array | undefined> {
  const provider = new NodeSourceProvider(options);
  return engine.readInput(await provider.worktree(path), inputRef);
}
/** Stream result bytes without resolving again for every resource. */
export async function* readResults(
  path?: string,
  options: NodeSourceOptions & engine.ResultReadOptions = {},
): AsyncGenerator<engine.ResultContent> {
  const provider = new NodeSourceProvider(options);
  yield* engine.readResults(await provider.worktree(path), options);
}

/** Resolve once and open result content only when a handle is consumed. */
export async function* resultResources(
  path?: string,
  options: NodeSourceOptions & engine.ResultReadOptions = {},
): AsyncGenerator<engine.ResultResource> {
  const provider = new NodeSourceProvider(options);
  yield* engine.resultResources(await provider.worktree(path), options);
}
