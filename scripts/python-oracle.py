"""Development-only oracle. The SDK never imports or invokes this program."""

from __future__ import annotations
import importlib.metadata
import json
import os
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "upstream" / "astra-tools" / "src"))
from astra import api  # noqa: E402

manifest = json.loads(
    (root / "upstream/astra-tools/tests/report-fixtures/manifest.json").read_text()
)
assert (
    importlib.metadata.version("astra-spec") == manifest["specification"]["release"]
), "Install the pinned astra-spec release"
report = api.validate(sys.argv[1])
result = {"validate": report.to_json()}
if report.valid:
    result["resolve"] = api.resolve(sys.argv[1]).to_json()
    result["status"] = api.status(sys.argv[1]).to_json()
print(json.dumps(result, allow_nan=False))
