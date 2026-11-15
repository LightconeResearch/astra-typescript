// Development-only bridge used by Python's upstream tests; the SDK never invokes Python.
import { readFileSync } from "node:fs";
import * as sdk from "../dist/node.js";
const request = JSON.parse(readFileSync(0, "utf8"));
if (!["validate", "resolve", "status"].includes(request.operation))
  throw new Error("Unknown oracle operation");
const result = await sdk[request.operation](
  request.path ?? undefined,
  request.options ?? {},
);
process.stdout.write(JSON.stringify(result));
