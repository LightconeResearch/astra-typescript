/** ASTRA 0.1 documents, structural validation, source locations and rule levels. */
import Ajv2019 from "ajv/dist/2019.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import {
  parseDocument,
  LineCounter,
  isMap,
  isSeq,
  isScalar,
  isAlias,
} from "yaml";
import type {
  Diagnostic,
  Location,
  Resources,
  TextQuoteSelector,
  FragmentSelector,
} from "../reports/types.js";
import type { LoadedAnalysis, ParsedDocument, Pointer } from "./model.js";
import {
  analysisSchema,
  provenanceSchema,
  openProvenanceSchema,
  ruleCatalogue,
} from "./spec.js";

export interface AuthoredInput {
  path: string;
  label?: string;
  description?: string;
  tags: readonly string[];
}
export interface AuthoredOption {
  label?: string;
  description?: string;
  tags: readonly string[];
  excluded?: string;
  requires: readonly string[];
  incompatible_with: readonly string[];
  insights: readonly string[];
}
export interface AuthoredDecision {
  options: Record<string, AuthoredOption>;
  label?: string;
  rationale?: string;
  tags: readonly string[];
}
export interface AuthoredRecipe {
  command: string;
  resources?: Resources;
}
export interface AuthoredOutput {
  type?: string;
  format?: string;
  recipe?: AuthoredRecipe;
  label?: string;
  description?: string;
  tags: readonly string[];
  inputs: readonly string[];
  decisions: readonly string[];
  switch?: string;
  cases: Record<string, string>;
}
export interface AuthoredUniverse {
  label?: string;
  description?: string;
  tags: readonly string[];
  decisions: Record<string, string>;
  derived_from?: string;
  analysis?: string;
  universe?: string;
}
export interface AuthoredEvidence {
  doi?: string;
  version?: number;
  artifact?: string;
  quote?: TextQuoteSelector;
  location?: FragmentSelector;
}
export interface AuthoredInsight {
  claim: string;
  evidence: readonly AuthoredEvidence[];
  label?: string;
  description?: string;
  scope?: string;
  tags: readonly string[];
}
export interface AuthoredDeclaration {
  path?: string;
  url?: string;
  commit?: string;
}
export interface AuthoredAnalysis {
  spec_version: string;
  label?: string;
  description?: string;
  tags: readonly string[];
  inputs: Record<string, AuthoredInput>;
  outputs: Record<string, AuthoredOutput>;
  decisions: Record<string, AuthoredDecision>;
  universes: Record<string, AuthoredUniverse>;
  analyses: Record<string, AuthoredDeclaration>;
  prior_insights: Record<string, AuthoredInsight>;
  findings: Record<string, AuthoredInsight>;
}
export const isSwitch = (output: AuthoredOutput): boolean =>
  output.switch !== undefined;
export const isImport = (universe: AuthoredUniverse): boolean =>
  universe.analysis !== undefined;
export const jsonPointer = (path: Pointer): string =>
  path
    .map((x) => "/" + String(x).replace(/~/g, "~0").replace(/\//g, "~1"))
    .join("");
export interface Rule {
  code: string;
  layer: string;
  level: string;
  statement: string;
  status?: string;
}
const own: Rule[] = [
  {
    code: "UNSUPPORTED_SPEC_VERSION",
    layer: "validator",
    level: "MUST",
    statement: "Only ASTRA 0.1 analyses are supported",
  },
  {
    code: "REMOTE_UNREACHABLE",
    layer: "validator",
    level: "MUST",
    statement: "Every remote commit can be read",
  },
  {
    code: "COMMIT_NOT_ANCESTOR",
    layer: "validator",
    level: "SHOULD",
    statement: "A declared local commit should be an ancestor",
  },
];
export const rules: ReadonlyMap<string, Rule> = new Map(
  [...ruleCatalogue.rules, ...own].map((r: Rule) => [r.code, r]),
);
export function diagnostic(
  code: string,
  message: string,
  location: Location,
  related: readonly Location[] = [],
): Diagnostic {
  const rule = rules.get(code);
  if (!rule) throw new Error(`Unknown ASTRA rule ${code}`);
  return {
    code,
    level: rule.level === "SHOULD" ? "warning" : "error",
    message,
    location,
    related,
  };
}
export class ParseError extends Error {
  readonly code = "INVALID_SYNTAX";
  constructor(
    message: string,
    readonly line?: number,
    readonly column?: number,
  ) {
    super(message);
    this.name = "ParseError";
  }
}
function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ParseError("the document is not UTF-8");
  }
}
/** Locate JSON parser failures consistently across V8 versions and Python's JSON decoder. */
function jsonSyntaxError(text: string, error: Error): ParseError {
  const constants: { offset: number; length: number; name: string }[] = [];
  const commas: number[] = [];
  let quoted = false,
    quoteStart = 0,
    previous = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === "\\") index++;
      else if (char === '"') {
        quoted = false;
        previous = '"';
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      quoteStart = index;
      continue;
    }
    if (/\s/.test(char)) continue;
    if (char === "," && /^[\t\r\n ]*[}\]]/.test(text.slice(index + 1)))
      commas.push(index);
    const constant = /^(?:-?Infinity|NaN)/.exec(text.slice(index));
    if (constant && (!previous || [":", "[", ","].includes(previous))) {
      constants.push({
        offset: index,
        length: constant[0].length,
        name: constant[0],
      });
      index += constant[0].length - 1;
      previous = "0";
    } else previous = char;
  }
  function offset(message: string): number {
    if (quoted && /unterminated string/i.test(message)) return quoteStart;
    const stated = /position (\d+)/.exec(message);
    let found = stated
      ? Number(stated[1])
      : /(?:unexpected end|end of JSON|end of data)/i.test(message)
        ? text.length
        : 0;
    // Python reports the comma, while V8 commonly reports the closing bracket after it.
    const comma = commas.find(
      (index) =>
        index < found &&
        /^[\t\r\n ]*[}\]]/.test(text.slice(index + 1, found + 1)),
    );
    if (comma !== undefined) found = comma;
    else if (
      !stated &&
      /Unexpected token ['"]?[}\]]/.test(message) &&
      commas.length
    )
      found = commas[0]!;
    return found;
  }
  if (constants.length) {
    // Mask only unquoted nonfinite tokens, preserving offsets. If parsing reaches
    // one before another syntax error, Python's parse_constant hook rejects it
    // without line/column information.
    const chars = text.split("");
    for (const token of constants)
      chars.splice(
        token.offset,
        token.length,
        "0",
        ...Array(token.length - 1).fill(" "),
      );
    let firstError = text.length + 1;
    try {
      JSON.parse(chars.join(""));
    } catch (other) {
      firstError = offset((other as Error).message);
    }
    const token = constants.find((token) => token.offset < firstError);
    if (token) return new ParseError(`${token.name} isn't a JSON number`);
  }
  const before = text.slice(0, offset(error.message));
  const line = before.split("\n").length;
  const column =
    Array.from(before.slice(before.lastIndexOf("\n") + 1)).length + 1;
  return new ParseError(`this is not JSON: ${error.message}`, line, column);
}
function parse(bytes: Uint8Array, json = false): ParsedDocument {
  const text = decode(bytes),
    lines = new LineCounter();
  if (json) {
    try {
      JSON.parse(text);
    } catch (error) {
      throw jsonSyntaxError(text, error as Error);
    }
  }
  const document = parseDocument(text, {
    version: "1.2",
    schema: "core",
    lineCounter: lines,
    uniqueKeys: true,
    merge: false,
    keepSourceTokens: true,
  });
  const point = (offset: number): { line: number; column: number } => {
    const line = Math.max(1, lines.linePos(offset).line);
    const start = lines.lineStarts[line - 1] ?? 0;
    return { line, column: Array.from(text.slice(start, offset)).length + 1 };
  };
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem) {
    const pos = problem.pos?.[0];
    const at = pos === undefined ? undefined : point(pos);
    throw new ParseError(
      problem.message,
      json ? undefined : at?.line,
      json ? undefined : at?.column,
    );
  }
  if (!json && !isMap(document.contents))
    throw new ParseError("the top level of the document must be a map", 1, 1);
  const starts = new WeakMap<object, number>();
  const prefix = (node: any, tokens: any[] | undefined) => {
    const offsets = (tokens ?? [])
      .filter((t) => t.type === "anchor" || t.type === "tag")
      .map((t) => t.offset);
    if (node && typeof node === "object" && offsets.length)
      starts.set(node, Math.min(...offsets));
  };
  function mark(node: any): void {
    if (isMap(node))
      for (const pair of node.items) {
        prefix(pair.key, (pair as any).srcToken?.start);
        prefix(pair.value, (pair as any).srcToken?.sep);
        mark(pair.key);
        mark(pair.value);
      }
    else if (isSeq(node))
      for (const [i, item] of node.items.entries()) {
        prefix(item, (node as any).srcToken?.items?.[i]?.start);
        mark(item);
      }
  }
  mark(document.contents);
  const position = (
    path: Pointer,
    key?: string,
  ): { line: number; column: number } | undefined => {
    let node: any = document.contents;
    for (const part of path) {
      if (isAlias(node)) node = node.resolve(document);
      if (isMap(node)) {
        const pair = node.items.find(
          (p: any) => isScalar(p.key) && p.key.value === part,
        );
        node = pair?.value;
      } else if (
        isSeq(node) &&
        (typeof part === "number" || /^\d+$/.test(String(part)))
      )
        node = node.items[Number(part)];
      else return undefined;
    }
    if (isAlias(node)) node = node.resolve(document);
    if (key !== undefined) {
      if (!isMap(node)) return undefined;
      node = node.items.find(
        (p: any) => isScalar(p.key) && p.key.value === key,
      )?.key;
    }
    if (!node?.range) return undefined;
    return point(starts.get(node) ?? node.range[0]);
  };
  let value: unknown;
  try {
    value = document.toJS({ mapAsMap: true, maxAliasCount: -1 });
  } catch (error) {
    throw new ParseError((error as Error).message);
  }
  const ancestors = new Set<object>();
  function convert(item: unknown, path: (string | number)[]): unknown {
    const bad = (message: string): never => {
      const at = position(path);
      throw new ParseError(message, at?.line, at?.column);
    };
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return item;
    if (typeof item === "number")
      return Number.isFinite(item) ? item : bad("JSON numbers must be finite");
    if (typeof item !== "object")
      return bad("the document contains a non-JSON value");
    if (ancestors.has(item)) return bad("recursive YAML aliases are not JSON");
    ancestors.add(item);
    let result: unknown;
    if (item instanceof Map) {
      const out: Record<string, unknown> = Object.create(null);
      for (const [k, v] of item) {
        if (typeof k !== "string") return bad("JSON map keys must be strings");
        out[k] = convert(v, [...path, k]);
      }
      result = out;
    } else if (Array.isArray(item))
      result = item.map((v, i) => convert(v, [...path, i]));
    else
      return bad("the document contains a value outside YAML 1.2 core schema");
    ancestors.delete(item);
    return result;
  }
  return {
    value: convert(value, []),
    position: json ? () => undefined : position,
  };
}
export function loadYaml(bytes: Uint8Array): ParsedDocument {
  return parse(bytes);
}
export function loadJson(bytes: Uint8Array): ParsedDocument {
  return parse(bytes, true);
}

let validators:
  | {
      analysis: ValidateFunction;
      provenance: ValidateFunction;
      open: ValidateFunction;
    }
  | undefined;
function strictPattern(pattern: string): string {
  let result = "",
    inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      result += pattern.slice(i, i + 2);
      i++;
      continue;
    }
    if (c === "[") inClass = true;
    if (c === "]") inClass = false;
    result += c === "$" && !inClass ? "(?![\\s\\S])" : c;
  }
  return result;
}
function contracts() {
  if (validators) return validators;
  const ajv = new Ajv2019({
    strict: false,
    allErrors: true,
    allowUnionTypes: true,
    ownProperties: true,
    validateFormats: false,
    verbose: true,
  });
  ajv.removeKeyword("uniqueItems");
  ajv.addKeyword({
    keyword: "uniqueItems",
    type: "array",
    schemaType: "boolean",
    errors: false,
    validate: (unique: boolean, data: unknown[]) =>
      !unique ||
      !data.some((item, i) =>
        data
          .slice(0, i)
          .some((other) => JSON.stringify(other) === JSON.stringify(item)),
      ),
  });
  ajv.removeKeyword("pattern");
  ajv.addKeyword({
    keyword: "pattern",
    type: "string",
    schemaType: "string",
    errors: false,
    compile: (pattern: string) => {
      const re = new RegExp(strictPattern(pattern), "u");
      return (value: string) => re.test(value);
    },
  });
  validators = {
    analysis: ajv.compile(analysisSchema),
    provenance: ajv.compile(provenanceSchema),
    open: ajv.compile(openProvenanceSchema),
  };
  return validators;
}
const schemaPointers = new WeakMap<object, string>();
function indexSchema(value: unknown, path = ""): void {
  if (!value || typeof value !== "object") return;
  schemaPointers.set(value, path);
  for (const [key, child] of Object.entries(value))
    indexSchema(
      child,
      path + "/" + key.replace(/~/g, "~0").replace(/\//g, "~1"),
    );
}
for (const schema of [analysisSchema, provenanceSchema, openProvenanceSchema])
  indexSchema(schema);
const pointerPath = (pointer: string): (string | number)[] =>
  pointer
    ? pointer
        .slice(1)
        .split("/")
        .map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~"))
    : [];
function at(
  document: ParsedDocument,
  file: string,
  path: Pointer,
  key?: string,
  commit?: string,
  url?: string,
): Location {
  const pos = document.position(path, key);
  return {
    file,
    pointer: jsonPointer(path),
    ...(pos ?? {}),
    ...(key !== undefined ? { key } : {}),
    ...(commit !== undefined ? { commit } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}
function version(value: any): number[] | undefined {
  return typeof value?.spec_version === "string" &&
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(
      value.spec_version,
    )
    ? value.spec_version.split(".").map(Number)
    : undefined;
}
function schemaDiagnostics(
  document: ParsedDocument,
  file: string,
  name: "analysis" | "provenance" | "open",
  commit?: string,
  url?: string,
): Diagnostic[] {
  const stated = version(document.value);
  if (
    stated &&
    (name === "analysis"
      ? stated[0] !== 0 || stated[1] !== 1
      : stated[0] === 0 && stated[1]! < 1)
  ) {
    const code =
      name === "analysis" ? "UNSUPPORTED_SPEC_VERSION" : "INVALID_RECORD";
    return [
      diagnostic(
        code,
        name === "analysis"
          ? `spec_version ${(document.value as any).spec_version} is not ASTRA 0.1`
          : `records begin at 0.1.0`,
        at(document, file, ["spec_version"], undefined, commit, url),
      ),
    ];
  }
  if (name !== "analysis" && stated && (stated[0]! > 0 || stated[1]! > 1))
    name = "open";
  const validator = contracts()[name];
  if (validator(document.value)) return [];
  const errors = [...(validator.errors ?? [])];
  const branches = errors
    .filter((e) => e.keyword === "oneOf")
    .map((e) => e.schemaPath + "/");
  const schema =
    name === "analysis"
      ? analysisSchema
      : name === "open"
        ? openProvenanceSchema
        : provenanceSchema;
  const found: Diagnostic[] = [];
  for (const error of errors) {
    if (
      error.keyword === "if" ||
      error.keyword === "propertyNames" ||
      branches.some((prefix) => error.schemaPath.startsWith(prefix))
    )
      continue;
    const parent = (error as ErrorObject & { parentSchema?: object })
      .parentSchema;
    const schemaPointer = parent && schemaPointers.get(parent);
    const uri = `${schema.$id}${schemaPointer !== undefined ? "#" + schemaPointer + "/" + error.keyword : error.schemaPath}`;
    const code = ruleCatalogue.errors[uri];
    if (!code) throw new Error(`Unmapped JSON Schema error ${uri}`);
    const path = pointerPath(error.instancePath),
      key =
        error.keyword === "additionalProperties"
          ? error.params.additionalProperty
          : (error as ErrorObject & { propertyName?: string }).propertyName;
    const location = at(document, file, path, key, commit, url);
    let message = error.message ?? "Schema validation failed";
    if (error.keyword === "additionalProperties")
      message = `\`${key}\` isn't a field here`;
    found.push(diagnostic(code, message, location));
  }
  return [...new Map(found.map((d) => [JSON.stringify(d), d])).values()];
}
const map = <T>(
  value: Record<string, any> | undefined,
  make: (v: any) => T,
): Record<string, T> => {
  const result: Record<string, T> = Object.create(null);
  for (const [key, item] of Object.entries(value ?? {}))
    result[key] = make(item);
  return result;
};
function normalize(raw: any): AuthoredAnalysis {
  const tagged = (v: any) => ({ ...v, tags: v.tags ?? [] });
  const insight = (v: any): AuthoredInsight => ({
    ...tagged(v),
    evidence: v.evidence ?? [],
  });
  return {
    ...tagged(raw),
    inputs: map(raw.inputs, tagged),
    outputs: map(raw.outputs, (v) => ({
      ...tagged(v),
      inputs: v.inputs ?? [],
      decisions: v.decisions ?? [],
      cases: v.cases ?? {},
    })),
    decisions: map(raw.decisions, (v) => ({
      ...tagged(v),
      options: map(v.options, (o) => ({
        ...tagged(o),
        requires: o.requires ?? [],
        incompatible_with: o.incompatible_with ?? [],
        insights: o.insights ?? [],
      })),
    })),
    universes: map(raw.universes, (v) => ({
      ...tagged(v),
      decisions: v.decisions ?? {},
    })),
    analyses: map(raw.analyses, (v) => ({ ...v })),
    prior_insights: map(raw.prior_insights, insight),
    findings: map(raw.findings, insight),
  };
}
function parsedDiagnostics(
  error: unknown,
  file: string,
  commit?: string,
  url?: string,
): Diagnostic[] {
  const err = error as ParseError;
  return [
    diagnostic("INVALID_SYNTAX", err.message, {
      file,
      pointer: "",
      ...(err.line !== undefined ? { line: err.line } : {}),
      ...(err.column !== undefined ? { column: err.column } : {}),
      ...(commit !== undefined ? { commit } : {}),
      ...(url !== undefined ? { url } : {}),
    }),
  ];
}
export function loadAnalysisDocument(
  bytes: Uint8Array,
  file: string,
  commit?: string,
  url?: string,
): LoadedAnalysis {
  let document: ParsedDocument;
  try {
    document = loadYaml(bytes);
  } catch (error) {
    return { diagnostics: parsedDiagnostics(error, file, commit, url) };
  }
  const diagnostics = schemaDiagnostics(
    document,
    file,
    "analysis",
    commit,
    url,
  );
  return {
    document,
    ...(diagnostics.length ? {} : { analysis: normalize(document.value) }),
    diagnostics,
  };
}
export function checkRecordDocument(
  bytes: Uint8Array,
  file: string,
  commit?: string,
  url?: string,
): { document?: ParsedDocument; diagnostics: readonly Diagnostic[] } {
  let document: ParsedDocument;
  try {
    document = loadJson(bytes);
  } catch (error) {
    return { diagnostics: parsedDiagnostics(error, file, commit, url) };
  }
  return {
    document,
    diagnostics: schemaDiagnostics(document, file, "provenance", commit, url),
  };
}
/** Check a parsed provenance record using its declared minor version. */
export function checkRecord(
  document: ParsedDocument,
  file: string,
  commit?: string,
  url?: string,
): readonly Diagnostic[] {
  return schemaDiagnostics(document, file, "provenance", commit, url);
}
