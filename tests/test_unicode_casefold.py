from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GENERATOR_PATH = ROOT / "scripts" / "generate_unicode_casefold.py"
MODULE_PATH = ROOT / "static" / "unicode_casefold.js"


def load_generator():
    specification = importlib.util.spec_from_file_location(
        "generate_unicode_casefold", GENERATOR_PATH
    )
    assert specification is not None
    assert specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def test_committed_casefold_module_exactly_matches_python_runtime_mapping():
    generator = load_generator()

    expected = {
        code_point: chr(code_point).casefold()
        for code_point in range(0x110000)
        if chr(code_point).casefold() != chr(code_point)
    }

    assert generator.casefold_mapping() == expected
    assert MODULE_PATH.read_text(encoding="utf-8") == generator.render_module()
