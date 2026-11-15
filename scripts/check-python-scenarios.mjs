// Explicit development/CI reuse of pinned Python scenarios, with native report comparisons.
import { spawnSync } from "node:child_process";
import { delimiter, dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length > 1)
  throw new Error(
    "Usage: node scripts/check-python-scenarios.mjs [python-executable]",
  );
const python = args[0] ?? process.env.ASTRA_PYTHON ?? "python3";
const tools = join(root, "upstream/astra-tools");
const result = spawnSync(
  python,
  [
    "-m",
    "pytest",
    "-q",
    "-p",
    "no:cacheprovider",
    "-p",
    "python_status_parity",
    "tests/test_status.py",
    "tests/test_resolve.py",
    "tests/test_switches_resolve.py",
  ],
  {
    cwd: tools,
    env: {
      ...process.env,
      ASTRA_NODE: process.execPath,
      PYTHONPATH: [join(root, "scripts"), join(tools, "src"), tools].join(
        delimiter,
      ),
    },
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
