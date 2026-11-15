# Portable report fixtures

These small repositories and their exact public-API JSON answers are an oracle for
other implementations, including TypeScript. They complement the specification's
validation conformance suite; they do not replace it. `manifest.json` pins the exact
Python oracle commit and the specification release actually installed when producing
these answers.

For each case, copy `files/` into an empty working folder outside any repository.
Run `sh -eu <absolute-case-path>/setup.sh` in that folder with only `PATH`, a fresh
empty `HOME`, `GIT_CEILING_DIRECTORIES` naming the working folder's parent, and
the manifest's `git_environment`. Both scripts explicitly use SHA-1 and a `main`
branch. No Python, network, cache, or recipe execution is involved in setup.

Call `validate`, `resolve`, and `status` against that working folder with networking
disabled. Compare each report's JSON with the corresponding case file. Object key
order is immaterial; array order is part of these exact answers. No temporary path
or nondeterministic timestamp is normalized away. Human diagnostic wording is
included to make drift reviewable; an independent implementation need only match
diagnostic codes, levels and locations unless it also promises identical wording.

- `driven`: two root universes, a driven stage, cyclic parent declaration, a shared
  result built once, a tracked input, and a pin to the stage's own universe. Every
  record is missing.
- `switch-status`: switches and a pinned input, inherited selections, evidence of
  a switch, pinned switch and switch with no result; records that are unchanged,
  stale directly or through an input, or missing; bytes that are present or absent.
  The stale recipe is edited after records are committed, so `head` alone does not
  fingerprint working files.

`tests/test_report_fixtures.py` builds these cases and checks all six reports using
only `astra.api`. To update a golden intentionally, build it in that same environment
and serialize the corresponding report's `to_json()` with UTF-8 and indentation;
review the JSON change along with the oracle revision metadata.
