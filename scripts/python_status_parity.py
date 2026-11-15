"""Explicit pytest plugin comparing upstream status scenarios with the built native SDK.

Run with scripts/, upstream/astra-tools/src and upstream/astra-tools on PYTHONPATH:
  python -m pytest -p python_status_parity upstream/astra-tools/tests/test_status.py
Python supplies test scenarios and the oracle only; it is never an SDK runtime dependency.
"""

from __future__ import annotations

import difflib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import tempfile

import pytest
from astra import api

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads(
    (ROOT / "upstream/astra-tools/tests/report-fixtures/manifest.json").read_text()
)
assert importlib.metadata.version("astra-spec") == MANIFEST["specification"]["release"]
assert Path(api.__file__).resolve().is_relative_to(ROOT / "upstream/astra-tools/src")
COMPARISONS = {"status": 0, "resolve": 0}
# Upstream tests/spec.py normally downloads a tagged archive. Point its cache at
# the exact spec submodule instead, before pytest imports any upstream test.
CACHE = tempfile.TemporaryDirectory(prefix="astra-pinned-pytest-")
OLD_CACHE = os.environ.get("XDG_CACHE_HOME")
PINNED = (
    Path(CACHE.name)
    / "astra-tools-tests"
    / f"astra-spec-v{MANIFEST['specification']['release']}"
)
PINNED.parent.mkdir(parents=True)
PINNED.symlink_to(ROOT / "upstream/astra-spec", target_is_directory=True)
os.environ["XDG_CACHE_HOME"] = CACHE.name


def normalize(value):
    """Preserve data and meaningful array ordering; omit diagnostic prose and ordering."""
    if isinstance(value, list):
        values = [normalize(item) for item in value]
        if values and all(
            isinstance(item, dict) and {"code", "level", "location"} <= item.keys()
            for item in values
        ):
            values.sort(key=lambda item: json.dumps(item, sort_keys=True))
        return values
    if isinstance(value, dict):
        diagnostic = {"code", "level", "location"} <= value.keys()
        result = {
            key: normalize(item)
            for key, item in value.items()
            if not (diagnostic and key == "message")
        }
        if diagnostic and "related" in result:
            result["related"].sort(key=lambda item: json.dumps(item, sort_keys=True))
        return result
    return value


def wrap(operation, original):
    def compare(path=None, *, offline=False):
        report = original(path, offline=offline)
        request = {
            "operation": operation,
            "path": None if path is None else os.fspath(path),
            "options": {"offline": offline},
        }
        if cache := os.environ.get("ASTRA_CACHE_DIR"):
            request["options"]["cacheDir"] = cache
        process = subprocess.run(
            [
                os.environ.get("ASTRA_NODE", "node"),
                str(ROOT / "scripts/native-oracle.mjs"),
            ],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            check=True,
        )
        actual, expected = (
            normalize(json.loads(process.stdout)),
            normalize(report.to_json()),
        )
        COMPARISONS[operation] += 1
        if actual != expected:
            diff = "\n".join(
                difflib.unified_diff(
                    json.dumps(expected, indent=2, sort_keys=True).splitlines(),
                    json.dumps(actual, indent=2, sort_keys=True).splitlines(),
                    fromfile=f"Python {operation}",
                    tofile=f"TypeScript {operation}",
                    lineterm="",
                )
            )
            pytest.fail(diff)
        return report

    return compare


@pytest.fixture(autouse=True)
def compare_native_reports(monkeypatch):
    for operation in ("resolve", "status"):
        monkeypatch.setattr(api, operation, wrap(operation, getattr(api, operation)))


def pytest_terminal_summary(terminalreporter):
    terminalreporter.write_line(f"Native TypeScript report comparisons: {COMPARISONS}")


def pytest_unconfigure(config):
    if OLD_CACHE is None:
        os.environ.pop("XDG_CACHE_HOME", None)
    else:
        os.environ["XDG_CACHE_HOME"] = OLD_CACHE
    CACHE.cleanup()
