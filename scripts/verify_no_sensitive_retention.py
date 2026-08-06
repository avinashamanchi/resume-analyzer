#!/usr/bin/env python3
"""Fail-closed retention architecture checks using the CPython 3.12 AST schema."""

from __future__ import annotations

import argparse
import ast
from collections import Counter
from dataclasses import dataclass
import hashlib
import re
import subprocess
import sys
from pathlib import Path


PRODUCTION_PREFIXES = ("server/", "static/", "contracts/")
PRODUCTION_FILES = {"app.py", "render.yaml", "Procfile"}
SENSITIVE_FIELDS = r"(?:resume_text|job_description|filename|pdf_base64)"

# Text gates remain for schemas, browser persistence, and non-AST store creation.
RULES = (
    (
        "sensitive-schema-field",
        re.compile(SENSITIVE_FIELDS, re.IGNORECASE),
        lambda path: path.startswith("contracts/"),
    ),
    (
        "durable-sql-content",
        re.compile(
            rf"(?:CREATE\s+TABLE|ALTER\s+TABLE|INSERT\s+INTO|UPDATE\s+\w+\s+SET)[^\n]*{SENSITIVE_FIELDS}",
            re.IGNORECASE,
        ),
        lambda path: path.startswith("server/"),
    ),
    (
        "durable-cache-content",
        re.compile(
            rf"(?:redis|cache|store|database|db)[\w.]*\.(?:set|put|write|insert|save|execute)\s*\([^\n]*{SENSITIVE_FIELDS}",
            re.IGNORECASE,
        ),
        lambda path: path.startswith("server/"),
    ),
    (
        "request-content-log",
        re.compile(
            r"(?:log(?:ger|ging)?|print)\s*\.?(?:info|debug|warning|error)?\s*\([^\n]*request\.(?:get_json|data|form|files|body|headers|cookies)",
            re.IGNORECASE,
        ),
        lambda path: path.startswith("server/"),
    ),
    (
        "browser-content-history",
        re.compile(
            r"(?:localStorage|sessionStorage|indexedDB|caches)\s*\.?(?:setItem|open|put)?\s*\([^\n]*(?:resume|job|filename|pdf|history)",
            re.IGNORECASE,
        ),
        lambda path: path.startswith("static/"),
    ),
    (
        "new-server-retention-store",
        re.compile(
            r"(?:sqlite3\.connect|shelve\.open|create_engine\s*\(|CREATE\s+TABLE)",
            re.IGNORECASE,
        ),
        lambda path: path.startswith("server/"),
    ),
    (
        "server-content-store",
        re.compile(
            rf"(?:shelve\.open|sqlite3\.connect|open\s*\([^\n]*[wa][+]?[^\n]*\)|Path\([^\n]*\)\.write_(?:text|bytes))[^\n]*{SENSITIVE_FIELDS}",
            re.IGNORECASE,
        ),
        lambda path: path.startswith("server/"),
    ),
)

CANONICAL_AST_PYTHON = (3, 12)
CAPABILITY_RULES = {
    "durable": "durable-storage-capability",
    "logging": "logging-sink",
    "dynamic": "dynamic-capability-synthesis",
}
DURABLE_MODULE_ROOTS = frozenset(
    {"psycopg", "psycopg2", "redis", "shelve", "sqlalchemy", "sqlite3"}
)
DURABLE_CONSTRUCTORS = frozenset(
    {
        "Connection",
        "Engine",
        "FileIO",
        "Redis",
        "StrictRedis",
        "create_engine",
    }
)
DURABLE_METHODS = frozenset(
    {
        "bulk_save_objects",
        "commit",
        "connect",
        "delete",
        "execute",
        "executemany",
        "expire",
        "from_url",
        "hset",
        "incr",
        "insert",
        "lpush",
        "merge",
        "mset",
        "multi",
        "pipeline",
        "rollback",
        "rpush",
        "sadd",
        "save",
        "set",
        "setdefault",
        "setex",
        "unwatch",
        "watch",
        "write_bytes",
        "write_text",
        "writelines",
        "xadd",
        "zadd",
    }
)
FILE_METHODS = frozenset(
    {
        "ftruncate",
        "open",
        "pwrite",
        "pwritev",
        "touch",
        "truncate",
        "write",
        "writev",
        "writelines",
    }
)
READABLE_OPEN_CAPABILITIES = frozenset(
    {
        "aiofiles.open",
        "builtins.open",
        "io.open",
        "os.fdopen",
        "os.open",
        "pathlib.Path.open",
    }
)
ALWAYS_DURABLE_FILE_CAPABILITIES = frozenset(
    {
        "io.FileIO",
        "tempfile.NamedTemporaryFile",
        "tempfile.SpooledTemporaryFile",
        "tempfile.TemporaryFile",
        "tempfile.mkdtemp",
        "tempfile.mkstemp",
    }
)
LOW_LEVEL_WRITE_CAPABILITIES = frozenset(
    {
        "os.ftruncate",
        "os.pwrite",
        "os.pwritev",
        "os.truncate",
        "os.write",
        "os.writev",
    }
)
DYNAMIC_BUILTINS = frozenset(
    {"__import__", "compile", "eval", "exec", "globals", "locals"}
)
DYNAMIC_CANONICAL_CAPABILITIES = frozenset(
    {
        "builtins.__import__",
        "builtins.compile",
        "builtins.eval",
        "builtins.exec",
        "builtins.globals",
        "builtins.locals",
        "operator.attrgetter",
        "operator.methodcaller",
    }
)
LOG_METHODS = frozenset(
    {"critical", "debug", "error", "exception", "info", "log", "warning"}
)
READ_ONLY_OPEN_MODES = frozenset({"br", "r", "rb", "rt", "tr"})
DURABLE_RECEIVER_PATTERN = re.compile(
    r"(?:^|_)(?:cache|connection|cursor|database|db|redis|shelf|shelve|sql|sqlite|store|transaction)(?:_|$)",
    re.IGNORECASE,
)
LOG_RECEIVER_PATTERN = re.compile(
    r"(?:^|_)(?:log|logger|logging|stderr|stdout)(?:_|$)", re.IGNORECASE
)


@dataclass(frozen=True)
class CapabilityAttestation:
    policy: str
    fingerprint: str
    count: int


@dataclass(frozen=True)
class TrustedBoundary:
    module_fingerprint: str
    approved_capabilities: tuple[CapabilityAttestation, ...]


TRUSTED_BOUNDARIES: dict[str, TrustedBoundary] = {
    "server/rate_limit.py": TrustedBoundary(
        module_fingerprint=(
            "eb7c5fa4887dd809b0c12a8b48c1de1d7259d5b4b5de2cbedd1a4106540667e4"
        ),
        approved_capabilities=(
            # transaction.delete
            CapabilityAttestation(
                "durable",
                "1861e3e1c73738f11ff460f711980eb0e94b5a62ef809044ef9e6ba3347a1356",
                1,
            ),
            # transaction.expire
            CapabilityAttestation(
                "durable",
                "2e5525fe367c3b1721f39433fac92a6ee4fa9abfb95486bbe117d081f5184a79",
                1,
            ),
            # transaction.execute (two call sites)
            CapabilityAttestation(
                "durable",
                "30ac02c88c7e8249dfba976649f2b0402089570462a0ef9287863cc38f6f1d60",
                2,
            ),
            # redis.exceptions import
            CapabilityAttestation(
                "durable",
                "41bb6862b9e67384b3b5bf4c6d2abfca15c92a15e6476ae98f0c5b06e4e655ad",
                1,
            ),
            # self._redis.pipeline (two call sites)
            CapabilityAttestation(
                "durable",
                "4e7660224a10225d5d36de126bf8627b22ab45310bfb9ce4879c7b7f849d84bb",
                2,
            ),
            # Redis.from_url
            CapabilityAttestation(
                "durable",
                "5f3f802995ef5259c58a81da281b7957a5c9887213d8dfe0497270a11be81547",
                1,
            ),
            # transaction.unwatch (two call sites)
            CapabilityAttestation(
                "durable",
                "76403351d874cdd6adb95ef4cc213f99efb22a059fa23ba660c3fb08dc07ead0",
                2,
            ),
            # transaction.watch (two call sites)
            CapabilityAttestation(
                "durable",
                "9abd1a816ca44db2c96795248c1e10e7cdf422661b767435104d06e9415b547f",
                2,
            ),
            # transaction.incr
            CapabilityAttestation(
                "durable",
                "acc838fa929cc76572c7de20fb6d720d8f05a52d1b53b4cd6a3f5c53d74e5cbe",
                1,
            ),
            # self._redis.set
            CapabilityAttestation(
                "durable",
                "b6909f6bcf1012f4b5402a529fa794d5315d14ffbe28566ce5ac9f6821d725dd",
                1,
            ),
            # Redis import
            CapabilityAttestation(
                "durable",
                "c994cd1971cad9038c734ff7a351099fe3b8ecba98d658febd8ef3ada5bf6249",
                1,
            ),
            # transaction.multi (two call sites)
            CapabilityAttestation(
                "durable",
                "f46bb03ba971150f6d0803a588a2024647577fe191eeab40b2d31bc80f22cf85",
                2,
            ),
            # ContextVar.set (two conservative set-capability matches)
            CapabilityAttestation(
                "durable",
                "f693074f0d94f9a6b9c70823f6edbacf88061ce0ca1f7698f716781fe571d065",
                2,
            ),
        ),
    ),
    "server/app.py": TrustedBoundary(
        module_fingerprint=(
            "a9381228e20769fafd51680ce9f29040be89c36a3d134800e2852e4b416e00f2"
        ),
        approved_capabilities=(
            # sys.stderr (write receiver and explicit flush receiver)
            CapabilityAttestation(
                "logging",
                "2c37fe503c4be9ad195b19655760a05c7ee9ff98e50100b31f2adb399baed6cb",
                2,
            ),
            # sys.stderr.write
            CapabilityAttestation(
                "logging",
                "f48fb992d4d732200eb68eb4ece8779628415e407dfeae7b6d69c2698a82fa1a",
                1,
            ),
        ),
    ),
    "server/gunicorn_logger.py": TrustedBoundary(
        module_fingerprint=(
            "b7aca9195ba3e7ae399aab1f398ee1e18adcb4510bb6095e9e31d5dd9d2bfd24"
        ),
        approved_capabilities=(
            # gunicorn.glogging.Logger import
            CapabilityAttestation(
                "logging",
                "2cf24e7c4e0991fd9cae84a578776e60e41b058e9a67a7be352976ed3f3b61c5",
                1,
            ),
            # super().exception
            CapabilityAttestation(
                "logging",
                "5fbd124d754fd2ef249e5c9ff21c8015633bb4b2d2ce936b9f4c9930ab62af6a",
                1,
            ),
            # super().error
            CapabilityAttestation(
                "logging",
                "7bfbb1e79a1d3053185a4dfe2504ea7db08b5bd1391b7a00e053577f2d0a2998",
                1,
            ),
            # super().warning (two call sites)
            CapabilityAttestation(
                "logging",
                "94c6bc7efaf9ed9ff637b8f520dae3c28d07d97fec9e8e5659cf4aaedcfda5c1",
                2,
            ),
        ),
    ),
}

AccessPath = tuple[str, ...]


def _dotted_name(node: ast.AST | None) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _dotted_name(node.value)
        return None if parent is None else f"{parent}.{node.attr}"
    return None


def _access_path(node: ast.AST | None) -> AccessPath | None:
    if isinstance(node, ast.Name):
        return (node.id,)
    if isinstance(node, ast.Attribute):
        parent = _access_path(node.value)
        return None if parent is None else (*parent, node.attr)
    if isinstance(node, ast.Subscript):
        parent = _access_path(node.value)
        if parent is None:
            return None
        if isinstance(node.slice, ast.Constant) and isinstance(
            node.slice.value, (str, int)
        ):
            return (*parent, f"[{node.slice.value!r}]")
        return (*parent, "[*]")
    return None


def _path_prefix_in(paths: set[AccessPath], path: AccessPath | None) -> bool:
    if path is None:
        return False
    return any(len(prefix) <= len(path) and path[: len(prefix)] == prefix for prefix in paths)


def _node_fingerprint(node: ast.AST) -> str:
    # This intentionally includes every CPython 3.12 AST field, including
    # type_params. Changing interpreter schemas requires an explicit re-attestation.
    def normalize(value: object) -> object:
        if isinstance(value, ast.AST):
            return (
                type(value).__name__,
                tuple(
                    (field, normalize(child))
                    for field, child in ast.iter_fields(value)
                ),
            )
        if isinstance(value, list):
            return tuple(normalize(item) for item in value)
        return value

    return hashlib.sha256(repr(normalize(node)).encode("utf-8")).hexdigest()


def _attested_node_ids(
    relative_path: str,
    tree: ast.Module,
    capability_nodes: dict[str, dict[int, ast.AST]],
) -> tuple[dict[str, set[int]], set[str]]:
    allowed = {policy: set() for policy in CAPABILITY_RULES}
    findings: set[str] = set()
    boundary = TRUSTED_BOUNDARIES.get(relative_path)
    if boundary is None:
        return allowed, findings

    expected = Counter(
        (approved.policy, approved.fingerprint)
        for approved in boundary.approved_capabilities
        for _ in range(approved.count)
    )
    observed = Counter(
        (policy, _node_fingerprint(node))
        for policy, nodes in capability_nodes.items()
        for node in nodes.values()
    )
    if (
        _node_fingerprint(tree) != boundary.module_fingerprint
        or observed != expected
    ):
        findings.add("trusted-retention-boundary-modified")
        return allowed, findings

    for policy, nodes in capability_nodes.items():
        allowed[policy].update(nodes)
    return allowed, findings


def _assigned_names(node: ast.AST) -> set[str]:
    if isinstance(node, ast.Name):
        return {node.id}
    if isinstance(node, ast.Starred):
        return _assigned_names(node.value)
    if isinstance(node, (ast.List, ast.Tuple)):
        return set().union(*(_assigned_names(item) for item in node.elts))
    return set()


def _assignment_pairs(
    target: ast.AST, value: ast.AST
) -> list[tuple[str, ast.AST]]:
    if (
        isinstance(target, (ast.List, ast.Tuple))
        and isinstance(value, (ast.List, ast.Tuple))
        and len(target.elts) == len(value.elts)
    ):
        return [
            pair
            for target_item, value_item in zip(target.elts, value.elts, strict=True)
            for pair in _assignment_pairs(target_item, value_item)
        ]
    return [(name, value) for name in _assigned_names(target)]


def _open_call_is_unsafe(node: ast.Call, mode_position: int) -> bool:
    if any(isinstance(argument, ast.Starred) for argument in node.args):
        return True
    if any(keyword.arg is None for keyword in node.keywords):
        return True
    mode: ast.AST | None = None
    if len(node.args) > mode_position:
        mode = node.args[mode_position]
    keyword_modes = [
        keyword.value for keyword in node.keywords if keyword.arg == "mode"
    ]
    if mode is not None and keyword_modes:
        return True
    if len(keyword_modes) > 1:
        return True
    if keyword_modes:
        mode = keyword_modes[0]
    if mode is None:
        return False
    if not isinstance(mode, ast.Constant) or not isinstance(mode.value, str):
        return True
    return mode.value not in READ_ONLY_OPEN_MODES


def _os_open_call_is_unsafe(
    node: ast.Call, read_only_flag_names: set[str]
) -> bool:
    if any(isinstance(argument, ast.Starred) for argument in node.args):
        return True
    if any(keyword.arg is None for keyword in node.keywords):
        return True
    flags: ast.AST | None = node.args[1] if len(node.args) >= 2 else None
    keyword_flags = [
        keyword.value for keyword in node.keywords if keyword.arg == "flags"
    ]
    if flags is not None and keyword_flags:
        return True
    if len(keyword_flags) > 1:
        return True
    if keyword_flags:
        flags = keyword_flags[0]
    if flags is None:
        return True
    if isinstance(flags, ast.Constant) and flags.value == 0:
        return False
    return _dotted_name(flags) not in read_only_flag_names


class ArchitecturalSinkVisitor(ast.NodeVisitor):
    """Discover exact storage, logging, and dynamic capability AST nodes."""

    def __init__(self) -> None:
        self.capability_nodes: dict[str, dict[int, ast.AST]] = {
            policy: {} for policy in CAPABILITY_RULES
        }
        self._module_aliases: dict[str, str] = {}
        self._alias_kinds: dict[str, str] = {
            "__import__": "dynamic",
            "compile": "dynamic",
            "eval": "dynamic",
            "exec": "dynamic",
            "globals": "dynamic",
            "getattr": "getattr",
            "open": "open",
            "print": "print",
            "locals": "dynamic",
            "vars": "vars",
        }
        self._durable_receivers: set[AccessPath] = set()
        self._path_values: set[AccessPath] = set()
        self._memory_values: set[AccessPath] = set()
        self._reflection_maps: set[AccessPath] = set()
        self._path_constructors: set[str] = {"Path"}
        self._logging_receivers: set[AccessPath] = set()
        self._parents: dict[int, ast.AST] = {}

    def visit(self, node: ast.AST) -> None:
        for child in ast.iter_child_nodes(node):
            self._parents[id(child)] = node
        super().visit(node)

    def _add(self, policy: str, node: ast.AST) -> None:
        self.capability_nodes[policy].setdefault(id(node), node)

    def _add_durable(self, node: ast.AST) -> None:
        self._add("durable", node)

    def _add_logging(self, node: ast.AST) -> None:
        self._add("logging", node)

    def _add_dynamic(self, node: ast.AST) -> None:
        self._add("dynamic", node)

    def _canonical_name(self, node: ast.AST | None) -> str | None:
        dotted = _dotted_name(node)
        if dotted is None:
            return None
        root, separator, suffix = dotted.partition(".")
        module = self._module_aliases.get(root)
        if module is None:
            return dotted
        return module if not separator else f"{module}.{suffix}"

    def _callable_kind(self, node: ast.AST | None) -> str | None:
        if isinstance(node, ast.Name) and node.id in self._alias_kinds:
            return self._alias_kinds[node.id]
        canonical = self._canonical_name(node)
        if canonical in {"open", "builtins.open"} | READABLE_OPEN_CAPABILITIES:
            return "open"
        if canonical in {"print", "builtins.print"}:
            return "print"
        if canonical in {"getattr", "builtins.getattr"}:
            return "getattr"
        if canonical in {"vars", "builtins.vars"}:
            return "vars"
        if canonical in DYNAMIC_BUILTINS | DYNAMIC_CANONICAL_CAPABILITIES:
            return "dynamic"
        if canonical is not None and canonical.startswith("importlib."):
            return "dynamic"
        return None

    def _identifier_is_durable(self, identifier: str) -> bool:
        return bool(DURABLE_RECEIVER_PATTERN.search(identifier))

    def _identifier_is_logging(self, identifier: str) -> bool:
        return bool(LOG_RECEIVER_PATTERN.search(identifier))

    def _is_durable_receiver(self, node: ast.AST | None) -> bool:
        path = _access_path(node)
        if _path_prefix_in(self._durable_receivers, path):
            return True
        if path is not None and any(
            self._identifier_is_durable(component) for component in path
        ):
            return True
        canonical = self._canonical_name(node)
        return canonical is not None and (
            canonical.split(".", 1)[0] in DURABLE_MODULE_ROOTS
        )

    def _is_path_value(self, node: ast.AST | None) -> bool:
        path = _access_path(node)
        if _path_prefix_in(self._path_values, path):
            return True
        if isinstance(node, ast.Call):
            canonical = self._canonical_name(node.func)
            return canonical is not None and (
                canonical.rsplit(".", 1)[-1] in self._path_constructors
            )
        return isinstance(node, ast.Name) and node.id in self._path_constructors

    def _is_logging_receiver(self, node: ast.AST | None) -> bool:
        path = _access_path(node)
        if _path_prefix_in(self._logging_receivers, path):
            return True
        if path is not None and any(
            self._identifier_is_logging(component) for component in path
        ):
            return True
        canonical = self._canonical_name(node)
        return canonical is not None and (
            canonical == "logging" or canonical.startswith("logging.")
        )

    def _is_memory_value(self, node: ast.AST | None) -> bool:
        path = _access_path(node)
        if _path_prefix_in(self._memory_values, path):
            return True
        if isinstance(node, ast.Call):
            canonical = self._canonical_name(node.func)
            return canonical in {"bytearray", "io.BytesIO", "io.StringIO"}
        return False

    def _is_reflection_map(self, node: ast.AST | None) -> bool:
        if isinstance(node, ast.Name) and node.id == "__builtins__":
            return True
        path = _access_path(node)
        if _path_prefix_in(self._reflection_maps, path):
            return True
        return isinstance(node, ast.Attribute) and node.attr == "__dict__"

    def _is_output_receiver(self, node: ast.AST | None) -> bool:
        canonical = self._canonical_name(node)
        return canonical in {"sys.stderr", "sys.stdout"} or (
            self._is_logging_receiver(node)
        )

    def _value_kind(self, node: ast.AST) -> str | None:
        if self._is_durable_receiver(node):
            return "durable"
        if self._is_path_value(node):
            return "path"
        if self._is_logging_receiver(node) or self._is_output_receiver(node):
            return "logging"
        if self._is_memory_value(node):
            return "memory"
        if self._is_reflection_map(node):
            return "reflection"
        if isinstance(node, ast.Call):
            canonical = self._canonical_name(node.func)
            final = canonical.rsplit(".", 1)[-1] if canonical else None
            if final in DURABLE_CONSTRUCTORS:
                return "durable"
        return None

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            bound = alias.asname or alias.name.split(".", 1)[0]
            module = alias.name if alias.asname else alias.name.split(".", 1)[0]
            root = alias.name.split(".", 1)[0]
            self._module_aliases[bound] = module
            if root in DURABLE_MODULE_ROOTS:
                self._durable_receivers.add((bound,))
                self._add_durable(node)
            if alias.name == "logging":
                self._logging_receivers.add((bound,))
                self._add_logging(node)
            if root == "importlib":
                self._add_dynamic(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = node.module or ""
        root = module.split(".", 1)[0]
        for alias in node.names:
            bound = alias.asname or alias.name
            canonical = f"{module}.{alias.name}" if module else alias.name
            self._module_aliases[bound] = canonical
            kind = self._callable_kind(ast.Name(id=bound))
            if kind is not None:
                self._alias_kinds[bound] = kind
            if root in DURABLE_MODULE_ROOTS:
                self._durable_receivers.add((bound,))
                self._add_durable(node)
            if module == "pathlib" and alias.name == "Path":
                self._path_constructors.add(bound)
            if canonical in READABLE_OPEN_CAPABILITIES:
                self._add_durable(node)
            if canonical in ALWAYS_DURABLE_FILE_CAPABILITIES:
                self._add_durable(node)
            if canonical in LOW_LEVEL_WRITE_CAPABILITIES:
                self._add_durable(node)
            if kind == "print":
                self._add_logging(node)
            if kind in {"getattr", "vars", "dynamic"}:
                self._add_dynamic(node)
            if root == "logging" or module == "gunicorn.glogging":
                self._logging_receivers.add((bound,))
                self._add_logging(node)
            if root == "importlib":
                self._add_dynamic(node)

    def _record_assignment(self, name: str, value: ast.AST) -> None:
        path = (name,)
        self._durable_receivers.discard(path)
        self._path_values.discard(path)
        self._memory_values.discard(path)
        self._reflection_maps.discard(path)
        self._logging_receivers.discard(path)
        self._alias_kinds.pop(name, None)

        value_kind = self._value_kind(value)
        if value_kind == "durable":
            self._durable_receivers.add(path)
        elif value_kind == "path":
            self._path_values.add(path)
        elif value_kind == "logging":
            self._logging_receivers.add(path)
        elif value_kind == "memory":
            self._memory_values.add(path)
        elif value_kind == "reflection":
            self._reflection_maps.add(path)

        callable_kind = self._callable_kind(value)
        if callable_kind is not None:
            self._alias_kinds[name] = callable_kind

    def visit_Assign(self, node: ast.Assign) -> None:
        self.visit(node.value)
        for target in node.targets:
            for name, value in _assignment_pairs(target, node.value):
                self._record_assignment(name, value)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if node.value is not None:
            self.visit(node.value)
            for name, value in _assignment_pairs(node.target, node.value):
                self._record_assignment(name, value)

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
        self.visit(node.value)
        for name, value in _assignment_pairs(node.target, node.value):
            self._record_assignment(name, value)

    def visit_Name(self, node: ast.Name) -> None:
        if not isinstance(node.ctx, ast.Load):
            return
        kind = self._callable_kind(node)
        if kind is None:
            return
        parent = self._parents.get(id(node))
        if isinstance(parent, ast.Call) and parent.func is node:
            return
        if kind == "open":
            self._add_durable(node)
        elif kind == "print":
            self._add_logging(node)
        else:
            self._add_dynamic(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        parent = self._parents.get(id(node))
        called = isinstance(parent, ast.Call) and parent.func is node
        canonical = self._canonical_name(node)
        final = canonical.rsplit(".", 1)[-1] if canonical else None

        if node.attr in {"__dict__", "__getattribute__"}:
            self._add_dynamic(node)
        if canonical in DYNAMIC_CANONICAL_CAPABILITIES or (
            canonical is not None and canonical.startswith("importlib.")
        ):
            self._add_dynamic(node)
        if canonical in {"builtins.print"}:
            self._add_logging(node)
        if canonical in READABLE_OPEN_CAPABILITIES and not called:
            self._add_durable(node)
        if canonical in ALWAYS_DURABLE_FILE_CAPABILITIES:
            self._add_durable(node)
        if canonical in LOW_LEVEL_WRITE_CAPABILITIES:
            self._add_durable(node)
        if node.attr in LOG_METHODS and (
            called or self._is_logging_receiver(node.value)
        ):
            self._add_logging(node)
        if canonical in {"sys.stderr", "sys.stdout"}:
            self._add_logging(node)
        if node.attr in DURABLE_METHODS:
            self._add_durable(node)
        elif node.attr in FILE_METHODS:
            if self._is_output_receiver(node.value):
                self._add_logging(node)
            elif self._is_memory_value(node.value):
                pass
            elif node.attr == "open" and called and self._is_path_value(node.value):
                pass
            elif self._is_path_value(node.value) or node.attr != "open":
                self._add_durable(node)
        if final in DURABLE_CONSTRUCTORS:
            self._add_durable(node)
        self.generic_visit(node)

    def visit_Subscript(self, node: ast.Subscript) -> None:
        method = (
            node.slice.value
            if isinstance(node.slice, ast.Constant)
            and isinstance(node.slice.value, str)
            else None
        )
        reflective = self._is_reflection_map(node.value) or (
            isinstance(node.value, ast.Call)
            and self._callable_kind(node.value.func) == "vars"
        )
        if reflective:
            self._add_dynamic(node)
            if method in DURABLE_METHODS | FILE_METHODS | {"open"}:
                self._add_durable(node)
            if method in LOG_METHODS | {"print"}:
                self._add_logging(node)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        canonical = self._canonical_name(node.func)
        final = canonical.rsplit(".", 1)[-1] if canonical else None
        kind = self._callable_kind(node.func)

        if kind == "print":
            self._add_logging(node)
        elif kind in {"vars", "dynamic"}:
            self._add_dynamic(node)
        elif kind == "getattr" and node.args:
            receiver = node.args[0]
            method = (
                node.args[1].value
                if len(node.args) >= 2
                and isinstance(node.args[1], ast.Constant)
                and isinstance(node.args[1].value, str)
                else None
            )
            if method is None or method in (
                {"__dict__", "__getattribute__", "attrgetter", "import_module"}
                | DYNAMIC_BUILTINS
            ):
                self._add_dynamic(node)
            if (
                self._is_durable_receiver(receiver)
                or self._is_path_value(receiver)
                or method in DURABLE_METHODS | FILE_METHODS | {"open"}
            ):
                self._add_durable(node)
            if self._is_logging_receiver(receiver) or method in LOG_METHODS | {
                "print"
            }:
                self._add_logging(node)

        if kind == "open":
            if canonical == "os.open":
                read_only_flags = {"os.O_RDONLY"} | {
                    f"{alias}.O_RDONLY"
                    for alias, module in self._module_aliases.items()
                    if module == "os"
                } | {
                    alias
                    for alias, module in self._module_aliases.items()
                    if module == "os.O_RDONLY"
                }
                unsafe_open = _os_open_call_is_unsafe(node, read_only_flags)
            elif canonical == "pathlib.Path.open":
                unsafe_open = _open_call_is_unsafe(
                    node,
                    1
                    if isinstance(node.func, ast.Attribute)
                    and not isinstance(node.func.value, ast.Call)
                    else 0,
                )
            else:
                unsafe_open = _open_call_is_unsafe(node, 1)
            if unsafe_open:
                self._add_durable(node)
        elif (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "open"
            and self._is_path_value(node.func.value)
            and _open_call_is_unsafe(node, 0)
        ):
            self._add_durable(node)

        if final in DURABLE_CONSTRUCTORS:
            self._add_durable(node)
        if canonical in ALWAYS_DURABLE_FILE_CAPABILITIES:
            self._add_durable(node)
        if canonical in LOW_LEVEL_WRITE_CAPABILITIES:
            self._add_durable(node)
        if isinstance(node.func, ast.Name) and self._identifier_is_logging(
            node.func.id
        ):
            self._add_logging(node)
        self.generic_visit(node)


def python_project_findings(contents: dict[str, str]) -> dict[str, set[str]]:
    findings = {relative_path: set() for relative_path in contents}
    if sys.version_info[:2] != CANONICAL_AST_PYTHON:
        for path_findings in findings.values():
            path_findings.add("unsupported-retention-verifier-python")
        return findings
    for relative_path, content in contents.items():
        try:
            tree = ast.parse(content)
        except (SyntaxError, ValueError):
            findings[relative_path].add("unparseable-production-python")
            continue
        visitor = ArchitecturalSinkVisitor()
        visitor.visit(tree)
        allowed, attestation_findings = _attested_node_ids(
            relative_path,
            tree,
            visitor.capability_nodes,
        )
        findings[relative_path].update(attestation_findings)
        for policy, nodes in visitor.capability_nodes.items():
            if any(node_id not in allowed[policy] for node_id in nodes):
                findings[relative_path].add(CAPABILITY_RULES[policy])
    return findings


def python_findings(content: str) -> set[str]:
    return python_project_findings({"app.py": content})["app.py"]


def tracked_files(root: Path) -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=root,
        check=False,
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError("not a Git repository")
    return [
        item.decode("utf-8")
        for item in result.stdout.split(b"\0")
        if item
    ]


def is_production_path(relative_path: str) -> bool:
    return relative_path in PRODUCTION_FILES or relative_path.startswith(
        PRODUCTION_PREFIXES
    )


def verify(root: Path) -> int:
    if sys.version_info[:2] != CANONICAL_AST_PYTHON:
        print(
            "Sensitive-retention verification failed: CPython 3.12 is required "
            "for canonical AST attestation.",
            file=sys.stderr,
        )
        return 2
    try:
        files = tracked_files(root)
    except RuntimeError:
        print(
            "Sensitive-retention verification failed: repository is unavailable.",
            file=sys.stderr,
        )
        return 2

    findings: set[tuple[str, str]] = set()
    production_contents: dict[str, str] = {}
    for relative_path in files:
        if not is_production_path(relative_path):
            continue
        path = root / relative_path
        try:
            content = path.read_text()
        except (OSError, UnicodeDecodeError):
            findings.add((relative_path, "unreadable-production-file"))
            continue
        if (
            relative_path == "app.py" or relative_path.startswith("server/")
        ) and relative_path.endswith(".py"):
            production_contents[relative_path] = content
        for rule_name, pattern, applies in RULES:
            if applies(relative_path) and pattern.search(content):
                findings.add((relative_path, rule_name))

    for relative_path, rules in python_project_findings(production_contents).items():
        findings.update((relative_path, rule_name) for rule_name in rules)

    if findings:
        print(
            f"Sensitive-retention verification failed: {len(findings)} prohibited production location"
            f"{'s' if len(findings) != 1 else ''}.",
            file=sys.stderr,
        )
        for relative_path, rule_name in sorted(findings):
            print(f"- {relative_path}: {rule_name}", file=sys.stderr)
        return 1

    print("Sensitive-retention verification passed.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    return verify(args.root.resolve())


if __name__ == "__main__":
    raise SystemExit(main())
