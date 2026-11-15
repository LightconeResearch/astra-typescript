/** File ownership, tracking and reserved-path rules. */
import type { Context } from "../universes.js";
import type { Tree } from "../../sources/types.js";
import { join, liesInside } from "../../sources/paths.js";
import { BUILT_IN, look } from "../../sources/standins.js";
import type { Diagnostic } from "../../reports/types.js";
export const INPUT_CODES = new Set([
  "MISSING_INPUT_FILE",
  "INPUT_NOT_TRACKED",
  "INPUT_IN_ANOTHER_ANALYSIS",
  "RESERVED_PATH",
]);
async function analysisBelow(
  reader: Tree,
  folder: string,
  path: string,
): Promise<string | undefined> {
  const segments = path.split("/").slice(0, -1);
  let at = folder;
  for (const segment of segments) {
    at = at ? `${at}/${segment}` : segment;
    const entry = await reader.stat(at);
    if (!entry || !["folder", "gitlink"].includes(entry.kind)) return undefined;
    if ((await reader.stat(`${at}/astra.yaml`))?.kind === "file") return at;
  }
  return undefined;
}
export async function checkInputs(context: Context): Promise<Diagnostic[]> {
  const found: Diagnostic[] = [];
  for (const [member, analysis] of context.stack.determined()) {
    const reader = member.reader,
      folder = member.identity.folder;
    const paths = new Map(
      Object.entries(analysis.inputs).map(([id, input]) => [
        id,
        join(folder, input.path),
      ]),
    );
    const possible = new Set<string>();
    for (const path of paths.values())
      if (path !== undefined) {
        possible.add(path);
        for (const standin of BUILT_IN) possible.add(standin.place(path));
      }
    const tracked = await reader.tracked(folder, possible);
    for (const [id, input] of Object.entries(analysis.inputs)) {
      const path = paths.get(id),
        at = context.at(member.identity, ["inputs", id, "path"]);
      const emit = (code: string, message: string) =>
        found.push(context.diagnostic(code, message, at));
      if (path === undefined) {
        emit(
          "INPUT_IN_ANOTHER_ANALYSIS",
          `\`${input.path}\` goes above the top of the repository`,
        );
        continue;
      }
      const entry = await reader.stat(path),
        content = await look(reader, path);
      const names = BUILT_IN.map((s) => s.name).join(", ");
      let why: string | undefined;
      if (entry?.kind === "folder") why = "is a folder: an input is one file";
      else if (entry?.kind === "gitlink")
        why = "is a submodule: read it through its analysis";
      else if (!content.here && !content.standin)
        why = entry
          ? `is a symlink, which is never followed, and no stand-in of ${names}`
          : `names no file, and no stand-in of ${names}`;
      if (why) emit("MISSING_INPUT_FILE", `\`${input.path}\` ${why}`);
      else {
        let kept = tracked.has(path);
        for (const standin of BUILT_IN)
          if (
            tracked.has(standin.place(path)) &&
            (await standin.recognises(reader, path))
          )
            kept = true;
        if (!kept)
          emit(
            "INPUT_NOT_TRACKED",
            `\`${input.path}\` isn't tracked in the repository that holds this analysis: git add it`,
          );
      }
      if (!liesInside(path, folder))
        emit(
          "INPUT_IN_ANOTHER_ANALYSIS",
          `\`${input.path}\` is outside this analysis's folder`,
        );
      else {
        const relative = folder ? path.slice(folder.length + 1) : path,
          inner = await analysisBelow(reader, folder, relative);
        if (inner !== undefined)
          emit(
            "INPUT_IN_ANOTHER_ANALYSIS",
            `\`${input.path}\` is inside \`${inner}\`, which holds an analysis of its own`,
          );
      }
    }
    const reserved: string[] = [];
    for (const other of context.stack.analyses.values())
      if (other.identity.commit === member.identity.commit)
        for (const name of ["results", ".astra"])
          reserved.push(
            other.identity.folder ? `${other.identity.folder}/${name}` : name,
          );
    const written: [readonly (string | number)[], string][] = [
      ...Object.entries(analysis.inputs).map(
        ([id, input]) =>
          [["inputs", id, "path"], input.path] as [
            readonly (string | number)[],
            string,
          ],
      ),
      ...Object.entries(analysis.analyses)
        .filter(([, d]) => d.path !== undefined)
        .map(
          ([id, d]) =>
            [["analyses", id, "path"], d.path!] as [
              readonly (string | number)[],
              string,
            ],
        ),
    ];
    for (const [pointer, path] of written) {
      const tidied = join(folder, path);
      if (tidied === undefined) continue;
      for (const reservedPath of reserved)
        if (tidied === reservedPath || liesInside(tidied, reservedPath)) {
          found.push(
            context.diagnostic(
              "RESERVED_PATH",
              `\`${path}\` lies inside \`${reservedPath}\`, which belongs to runners`,
              context.at(member.identity, pointer),
            ),
          );
          break;
        }
    }
  }
  return found;
}
