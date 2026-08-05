from __future__ import annotations

import importlib.util
import unicodedata
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GENERATOR_PATH = ROOT / "scripts" / "generate_unicode_casefold.py"
MODULE_PATH = ROOT / "static" / "unicode_casefold.js"
NORMALIZATION_MODULE_PATH = ROOT / "static" / "unicode_normalization.js"
NORMALIZATION_CORPUS_PATH = ROOT / "tests" / "fixtures" / "unicode" / "nfkc-python-15.json"


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


def test_committed_nfkc_module_and_multi_scalar_corpus_match_python_runtime():
    generator = load_generator()

    expected = {
        code_point: unicodedata.normalize("NFKC", chr(code_point))
        for code_point in range(0x110000)
        if unicodedata.normalize("NFKC", chr(code_point)) != chr(code_point)
    }

    assert generator.nfkc_mapping() == expected
    assert NORMALIZATION_MODULE_PATH.read_text(encoding="utf-8") == generator.render_normalization_module()
    assert NORMALIZATION_CORPUS_PATH.read_text(encoding="utf-8") == generator.render_normalization_corpus()
