/** Internal identities and bindings. Object identities are interned within one stack. */
import type { Diagnostic, Location } from "../reports/types.js";
import type { AuthoredAnalysis, AuthoredDeclaration } from "./documents.js";
import type { Tree } from "../sources/types.js";

export type Pointer = readonly (string | number)[];
export type Kind = "input" | "output" | "switch" | "decision" | "universe";
export type Field =
  | "inputs"
  | "decisions"
  | "switch"
  | "case"
  | "requires"
  | "incompatible_with"
  | "selection"
  | "artifact"
  | "import";
export interface Identity {
  readonly key: string;
  readonly folder: string;
  readonly commit?: string;
}
export interface Element {
  readonly key: string;
  readonly analysis: Identity;
  readonly kind: Kind;
  readonly id: string;
}
export type At = readonly [Element, Element | undefined];
export type Outcome =
  | "reached"
  | "invalid"
  | "outside"
  | "missing"
  | "absent"
  | "unreachable";
export interface Declaration {
  readonly owner: Identity;
  readonly id: string;
  readonly declared: AuthoredDeclaration;
  readonly outcome: Outcome;
  readonly folder?: string;
  readonly reached?: Identity;
  readonly unreachable?: readonly [string | undefined, string];
}
export interface ParsedDocument {
  readonly value: unknown;
  position(
    path: Pointer,
    key?: string,
  ): { line: number; column: number } | undefined;
}
export interface Member {
  readonly identity: Identity;
  readonly reader: Tree;
  readonly file: string;
  readonly document?: ParsedDocument;
  readonly analysis?: AuthoredAnalysis;
  readonly declarations: Map<string, Declaration>;
  readonly url?: string;
}
export interface Address {
  readonly segments: readonly string[];
  readonly declarations: readonly string[];
  readonly id: string;
}
export interface Resolution {
  readonly file: Identity;
  readonly owner?: Element;
  readonly field: Field;
  readonly pointer: Pointer;
  readonly key?: string;
  readonly written: string;
  readonly address: Address;
  readonly pin?: string;
  readonly option?: string;
  readonly chain: readonly Declaration[];
  readonly element?: Element;
  readonly undetermined: boolean;
}
export interface Switch {
  readonly decision: Resolution;
  readonly cases: Map<string, Resolution>;
}
export const TAKES: Record<Field, readonly Kind[]> = {
  inputs: ["input", "output", "switch"],
  decisions: ["decision"],
  switch: ["decision"],
  case: ["input", "output", "switch"],
  requires: ["decision"],
  incompatible_with: ["decision"],
  selection: ["decision"],
  artifact: ["output", "switch"],
  import: ["universe"],
};
export const jsonPointer = (pointer: Pointer): string =>
  pointer
    .map((x) => "/" + String(x).replace(/~/g, "~0").replace(/\//g, "~1"))
    .join("");
export const identityName = (identity: Identity): string =>
  `${identity.folder || "."}${identity.commit ? ` at ${identity.commit}` : ""}`;
export const chainKey = (chain: readonly Declaration[]): string =>
  JSON.stringify(chain.map((d) => [d.owner.key, d.id]));
export const atKey = (element: Element, universe?: Element): string =>
  JSON.stringify([element.key, universe?.key ?? null]);

export class Stack {
  readonly analyses = new Map<Identity, Member>();
  readonly resolutions: Resolution[] = [];
  readonly switches = new Map<Element, Switch>();
  readonly identities = new Map<string, Identity>();
  readonly elements = new Map<string, Element>();
  readonly points = new Map<string, At>();
  readonly root: Identity;
  constructor(folder: string, commit?: string) {
    this.root = this.identity(folder, commit);
  }
  identity(folder: string, commit?: string): Identity {
    const key = JSON.stringify([folder, commit ?? null]);
    let found = this.identities.get(key);
    if (!found) {
      found = { key, folder, ...(commit !== undefined ? { commit } : {}) };
      this.identities.set(key, found);
    }
    return found;
  }
  element(analysis: Identity, kind: Kind, id: string): Element {
    const key = JSON.stringify([analysis.key, kind, id]);
    let found = this.elements.get(key);
    if (!found) {
      found = { key, analysis, kind, id };
      this.elements.set(key, found);
    }
    return found;
  }
  at(element: Element, universe?: Element): At {
    const key = atKey(element, universe);
    let found = this.points.get(key);
    if (!found) {
      found = [element, universe];
      this.points.set(key, found);
    }
    return found;
  }
  resolveElement(written: string, kind: Kind): Element | undefined {
    const parts = written.split(".");
    const id = parts.pop()!;
    let current = this.root;
    for (const part of parts) {
      const d = this.analyses.get(current)?.declarations.get(part);
      if (d?.outcome !== "reached" || !d.reached) return undefined;
      current = d.reached;
    }
    const a = this.analyses.get(current)?.analysis;
    if (!a) return undefined;
    const found =
      kind === "input"
        ? Object.hasOwn(a.inputs, id)
        : kind === "decision"
          ? Object.hasOwn(a.decisions, id)
          : kind === "universe"
            ? Object.hasOwn(a.universes, id) &&
              a.universes[id]!.analysis === undefined
            : Object.hasOwn(a.outputs, id) &&
              (a.outputs[id]!.switch !== undefined) === (kind === "switch");
    return found ? this.element(current, kind, id) : undefined;
  }
  analysis(identity: Identity): AuthoredAnalysis {
    const found = this.analyses.get(identity)?.analysis;
    if (!found)
      throw new Error(`Undetermined analysis ${identityName(identity)}`);
    return found;
  }
  *determined(): Generator<readonly [Member, AuthoredAnalysis]> {
    for (const member of this.analyses.values())
      if (member.analysis) yield [member, member.analysis];
  }
  location(identity: Identity, pointer: Pointer, key?: string): Location {
    const member = this.analyses.get(identity)!;
    const position = member.document?.position(pointer, key);
    return {
      file: member.file,
      pointer: jsonPointer(pointer),
      ...(position ?? {}),
      ...(key !== undefined ? { key } : {}),
      ...(identity.commit !== undefined ? { commit: identity.commit } : {}),
      ...(member.url !== undefined ? { url: member.url } : {}),
    };
  }
}
export interface LoadedAnalysis {
  readonly document?: ParsedDocument;
  readonly analysis?: AuthoredAnalysis;
  readonly diagnostics: readonly Diagnostic[];
}
