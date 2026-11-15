/** ASTRA address grammar and literal command-template substitution. */
export interface Address {
  readonly segments: readonly string[];
  readonly declarations: readonly string[];
  readonly id: string;
}
export interface Reference {
  readonly address: Address;
  readonly pin?: string;
}
export interface OptionReference {
  readonly decision: Address;
  readonly option: string;
}
export function parseAddress(text: string): Address {
  const segments = text.split(".");
  return {
    segments,
    declarations: segments.slice(0, -1),
    id: segments.at(-1)!,
  };
}
export function addressText(address: Address): string {
  return address.segments.join(".");
}
export function parseReference(text: string): Reference {
  const hash = text.indexOf("#");
  return hash < 0
    ? { address: parseAddress(text) }
    : { address: parseAddress(text.slice(0, hash)), pin: text.slice(hash + 1) };
}
export function parseOptionReference(text: string): OptionReference {
  const address = parseAddress(text);
  return {
    decision: parseAddress(address.declarations.join(".")),
    option: address.id,
  };
}
export const TEMPLATE = /\{\{|\}\}|\{([^}]*)\}/g;
export function fill(
  command: string,
  values: {
    inputs: Readonly<Record<string, string>> | ReadonlyMap<string, string>;
    decisions:
      | Readonly<Record<string, string | undefined>>
      | ReadonlyMap<string, string | undefined>;
    output: string;
  },
): string {
  const entries = (
    given: typeof values.inputs | typeof values.decisions,
  ): [string, string | undefined][] =>
    given instanceof Map ? [...given] : Object.entries(given);
  const inputs = new Map(entries(values.inputs));
  const decisions = new Map(entries(values.decisions));
  return command.replace(
    TEMPLATE,
    (text: string, placeholder: string | undefined) => {
      if (placeholder === undefined) return text[0]!;
      if (placeholder === "output") return values.output;
      if (placeholder === "inputs") return [...inputs.values()].join(" ");
      const dot = placeholder.indexOf(".");
      const field = placeholder.slice(0, dot),
        entry = placeholder.slice(dot + 1);
      const given =
        field === "inputs"
          ? inputs
          : field === "decisions"
            ? decisions
            : undefined;
      if (dot < 0 || !given?.has(entry))
        throw new Error(`Unknown template placeholder: ${placeholder}`);
      return given.get(entry) ?? "";
    },
  );
}
