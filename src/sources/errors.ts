export class GitError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitError";
  }
}
export class CacheError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CacheError";
  }
}
export class NoAnalysisError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NoAnalysisError";
  }
}
export class UnreachableError extends Error {
  constructor(
    readonly url: string | undefined,
    readonly commit: string,
  ) {
    super(`${commit} can't be got from ${url ?? "a submodule with no URL"}`);
    this.name = "UnreachableError";
  }
}
