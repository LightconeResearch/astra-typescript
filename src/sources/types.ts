/** Host-neutral repository access. Paths are normalized, repository-relative POSIX paths. */
import type { Commit } from "../reports/types.js";

export type EntryKind = "file" | "folder" | "symlink" | "gitlink";
export interface Entry {
  readonly kind: EntryKind;
  readonly target?: string;
}
export interface FollowedFile {
  readonly path: string;
  readonly size: number;
  read(limit?: number): Promise<Uint8Array>;
  digest?(): Promise<Digest>;
}
export interface Repository {
  readonly top: string;
  head(): Promise<string | undefined>;
  hasCommit(commit: string): Promise<boolean>;
  commit(revision: string): Promise<string | undefined>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  remoteUrl(): Promise<string | undefined>;
  tracked(paths: Iterable<string>): Promise<ReadonlySet<string>>;
}
export interface Tree {
  readonly id: string;
  readonly repo?: Repository;
  readonly commit?: Commit;
  read(path: string, limit?: number): Promise<Uint8Array>;
  stat(path: string): Promise<Entry | undefined>;
  tracked(
    folder: string,
    paths: Iterable<string>,
  ): Promise<ReadonlySet<string>>;
  holding(
    folder: string,
  ): Promise<{ readonly repository: Repository; readonly folder: string }>;
  /** Following is reserved for recognised large-file stand-ins. */
  follow(path: string): Promise<FollowedFile | undefined>;
  /** Locate a file across gitlinks, preserving its actual repository and commit. */
  locate?(
    path: string,
  ): Promise<{ readonly reader: Tree; readonly path: string } | undefined>;
  digest?(path: string): Promise<Digest | undefined>;
}
export interface AnalysisSource {
  readonly reader: Tree;
  readonly folder: string;
  readonly provider: SourceProvider;
}
export interface Declaration {
  readonly path?: string;
  readonly url?: string;
  readonly commit?: string;
}
export type DeclarationOutcome =
  | "reached"
  | "outside"
  | "missing"
  | "absent"
  | "unreachable";
export interface DeclarationSource {
  readonly outcome: DeclarationOutcome;
  readonly reader?: Tree;
  readonly folder?: string;
  readonly url?: string;
  readonly unreachable?: readonly [string | undefined, string];
}
export interface SourceProvider {
  readonly offline: boolean;
  worktree(path?: string): Promise<AnalysisSource>;
  atCommit(repository: Repository, commit: string, url?: string): Promise<Tree>;
  remote(
    url: string | undefined,
    commit: string,
    local?: Repository,
  ): Promise<Repository | undefined>;
  declaration(
    reader: Tree,
    folder: string,
    declaration: Declaration,
  ): Promise<DeclarationSource>;
}
export interface Digest {
  readonly content_hash: string;
  readonly size: number;
}
