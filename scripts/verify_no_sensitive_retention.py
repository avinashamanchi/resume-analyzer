#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ast
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

DURABLE_MODULE_ROOTS = frozenset(
    {"redis", "shelve", "sqlalchemy", "sqlite3"}
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
        "delete",
        "execute",
        "executemany",
        "expire",
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
FILE_METHODS = frozenset({"open", "touch", "write", "writelines"})
FILE_OPEN_CAPABILITIES = frozenset(
    {
        "aiofiles.open",
        "builtins.open",
        "io.FileIO",
        "io.open",
        "os.fdopen",
        "os.open",
        "pathlib.Path.open",
        "tempfile.NamedTemporaryFile",
        "tempfile.TemporaryFile",
    }
)
LOG_METHODS = frozenset(
    {"critical", "debug", "error", "exception", "info", "log", "warning"}
)
DURABLE_RECEIVER_PATTERN = re.compile(
    r"(?:^|_)(?:cache|connection|cursor|database|db|redis|shelf|shelve|sql|sqlite|store|transaction)(?:_|$)",
    re.IGNORECASE,
)
LOG_RECEIVER_PATTERN = re.compile(
    r"(?:^|_)(?:log|logger|logging|stderr|stdout)(?:_|$)", re.IGNORECASE
)


@dataclass(frozen=True)
class TrustedBoundary:
    fingerprint: str
    policy: str


TRUSTED_BOUNDARIES: dict[str, tuple[TrustedBoundary, ...]] = {
    "server/rate_limit.py": (
        TrustedBoundary(
            "64fae6082862abdd80a0e31492fd30c6ee7982b42c4da30e1e00d08ba7c1151a",
            "durable",
        ),
    ),
    "server/app.py": (
        TrustedBoundary(
            "6b591616b49d3a8de8f26d320a0af1efb027171264a733f9982d5c055a50038a",
            "logging",
        ),
    ),
    "server/gunicorn_logger.py": (
        TrustedBoundary(
            "dd302863aa4e623d1eb82523452d499f73384157af26ab1b6b750a85637ff227",
            "logging",
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
    def normalize(value: object) -> object:
        if isinstance(value, ast.AST):
            return (
                type(value).__name__,
                tuple(
                    (field, normalize(child))
                    for field, child in ast.iter_fields(value)
                    if field != "type_params"
                ),
            )
        if isinstance(value, list):
            return tuple(normalize(item) for item in value)
        return value

    return hashlib.sha256(repr(normalize(node)).encode("utf-8")).hexdigest()


def _attested_node_ids(
    relative_path: str, tree: ast.Module
) -> tuple[set[int], set[int], set[str]]:
    allowed_durable: set[int] = set()
    allowed_logging: set[int] = set()
    findings: set[str] = set()
    for boundary in TRUSTED_BOUNDARIES.get(relative_path, ()):
        if _node_fingerprint(tree) != boundary.fingerprint:
            findings.add("trusted-retention-boundary-modified")
            continue
        target = allowed_durable if boundary.policy == "durable" else allowed_logging
        target.update(id(node) for node in ast.walk(tree))
    return allowed_durable, allowed_logging, findings


def _assigned_names(node: ast.AST) -> set[str]:
    if isinstance(node, ast.Name):
        return {node.id}
    if isinstance(node, (ast.List, ast.Tuple)):
        return set().union(*(_assigned_names(item) for item in node.elts))
    return set()


def _open_call_writes(node: ast.Call) -> bool:
    mode: str | None = None
    if len(node.args) >= 2 and isinstance(node.args[1], ast.Constant):
        mode = node.args[1].value if isinstance(node.args[1].value, str) else None
    for keyword in node.keywords:
        if keyword.arg == "mode" and isinstance(keyword.value, ast.Constant):
            mode = keyword.value.value if isinstance(keyword.value.value, str) else None
    return isinstance(mode, str) and any(marker in mode for marker in "awx+")


def _path_open_call_writes(node: ast.Call) -> bool:
    mode: str | None = None
    if node.args and isinstance(node.args[0], ast.Constant):
        mode = node.args[0].value if isinstance(node.args[0].value, str) else None
    for keyword in node.keywords:
        if keyword.arg == "mode" and isinstance(keyword.value, ast.Constant):
            mode = keyword.value.value if isinstance(keyword.value.value, str) else None
    return isinstance(mode, str) and any(marker in mode for marker in "awx+")


class ArchitecturalSinkVisitor(ast.NodeVisitor):
    """Reject retention and logging capabilities outside pinned AST boundaries."""

    def __init__(
        self,
        *,
        allowed_durable: set[int],
        allowed_logging: set[int],
    ) -> None:
        self.findings: set[str] = set()
        self._allowed_durable = allowed_durable
        self._allowed_logging = allowed_logging
        self._module_aliases: dict[str, str] = {}
        self._durable_receivers: set[AccessPath] = set()
        self._path_values: set[AccessPath] = set()
        self._memory_values: set[AccessPath] = set()
        self._path_constructors: set[str] = {"Path"}
        self._open_aliases: set[str] = {"open"}
        self._logging_receivers: set[AccessPath] = set()
        self._print_aliases: set[str] = {"print"}
        self._parents: dict[int, ast.AST] = {}

    def visit(self, node: ast.AST) -> None:
        for child in ast.iter_child_nodes(node):
            self._parents[id(child)] = node
        super().visit(node)

    def _add_durable(self, node: ast.AST) -> None:
        if id(node) not in self._allowed_durable:
            self.findings.add("durable-storage-capability")

    def _add_logging(self, node: ast.AST) -> None:
        if id(node) not in self._allowed_logging:
            self.findings.add("logging-sink")

    def _canonical_name(self, node: ast.AST | None) -> str | None:
        dotted = _dotted_name(node)
        if dotted is None:
            return None
        root, separator, suffix = dotted.partition(".")
        module = self._module_aliases.get(root)
        if module is None:
            return dotted
        return module if not separator else f"{module}.{suffix}"

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
        return canonical is not None and canonical.split(".", 1)[0] in DURABLE_MODULE_ROOTS

    def _is_path_value(self, node: ast.AST | None) -> bool:
        path = _access_path(node)
        if _path_prefix_in(self._path_values, path):
            return True
        if isinstance(node, ast.Call):
            canonical = self._canonical_name(node.func)
            return canonical is not None and canonical.rsplit(".", 1)[-1] in self._path_constructors
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

    def _is_output_receiver(self, node: ast.AST | None) -> bool:
        canonical = self._canonical_name(node)
        return canonical in {"sys.stderr", "sys.stdout"} or self._is_logging_receiver(node)

    def _value_kind(self, node: ast.AST) -> str | None:
        if self._is_durable_receiver(node):
            return "durable"
        if self._is_path_value(node):
            return "path"
        if self._is_logging_receiver(node) or self._is_output_receiver(node):
            return "logging"
        if self._is_memory_value(node):
            return "memory"
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
            self._module_aliases[bound] = module
            if alias.name.split(".", 1)[0] in DURABLE_MODULE_ROOTS:
                self._durable_receivers.add((bound,))
                self._add_durable(node)
            if alias.name == "logging":
                self._logging_receivers.add((bound,))
                self._add_logging(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = node.module or ""
        root = module.split(".", 1)[0]
        for alias in node.names:
            bound = alias.asname or alias.name
            canonical = f"{module}.{alias.name}" if module else alias.name
            self._module_aliases[bound] = canonical
            if root in DURABLE_MODULE_ROOTS:
                self._durable_receivers.add((bound,))
                self._add_durable(node)
            if module == "pathlib" and alias.name == "Path":
                self._path_constructors.add(bound)
            if module == "builtins" and alias.name == "open":
                self._open_aliases.add(bound)
                self._add_durable(node)
            if canonical in FILE_OPEN_CAPABILITIES:
                self._open_aliases.add(bound)
                self._add_durable(node)
            if module == "builtins" and alias.name == "print":
                self._print_aliases.add(bound)
                self._add_logging(node)
            if root == "logging" or module == "gunicorn.glogging":
                self._logging_receivers.add((bound,))
                self._add_logging(node)

    def _record_assignment(self, target: ast.AST, value: ast.AST) -> None:
        kind = self._value_kind(value)
        for name in _assigned_names(target):
            path = (name,)
            self._durable_receivers.discard(path)
            self._path_values.discard(path)
            self._memory_values.discard(path)
            self._logging_receivers.discard(path)
            self._open_aliases.discard(name)
            self._print_aliases.discard(name)
            if kind == "durable":
                self._durable_receivers.add(path)
            elif kind == "path":
                self._path_values.add(path)
            elif kind == "logging":
                self._logging_receivers.add(path)
            elif kind == "memory":
                self._memory_values.add(path)
            if isinstance(value, ast.Name) and value.id in self._open_aliases:
                self._open_aliases.add(name)
                self._add_durable(value)
            if isinstance(value, ast.Name) and value.id in self._print_aliases:
                self._print_aliases.add(name)
                self._add_logging(value)

    def visit_Assign(self, node: ast.Assign) -> None:
        self.visit(node.value)
        for target in node.targets:
            self._record_assignment(target, node.value)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if node.value is not None:
            self.visit(node.value)
            self._record_assignment(node.target, node.value)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        parent = self._parents.get(id(node))
        called = isinstance(parent, ast.Call) and parent.func is node
        if node.attr in LOG_METHODS and (called or self._is_logging_receiver(node.value)):
            self._add_logging(node)
        if self._canonical_name(node) in {"sys.stderr", "sys.stdout"}:
            self._add_logging(node)
        if node.attr in DURABLE_METHODS:
            self._add_durable(node)
        elif node.attr in FILE_METHODS:
            if self._is_output_receiver(node.value):
                self._add_logging(node)
            elif self._is_memory_value(node.value):
                pass
            elif self._is_path_value(node.value) or node.attr != "open":
                self._add_durable(node)
        canonical = self._canonical_name(node)
        final = canonical.rsplit(".", 1)[-1] if canonical else None
        if canonical in FILE_OPEN_CAPABILITIES:
            self._add_durable(node)
        if final in DURABLE_CONSTRUCTORS:
            self._add_durable(node)
        self.generic_visit(node)

    def visit_Subscript(self, node: ast.Subscript) -> None:
        if isinstance(node.value, ast.Attribute) and node.value.attr == "__dict__":
            owner = node.value.value
            dynamic_method = not (
                isinstance(node.slice, ast.Constant)
                and isinstance(node.slice.value, str)
            )
            if dynamic_method:
                self._add_durable(node)
                self._add_logging(node)
            if self._is_durable_receiver(owner) or self._is_path_value(owner):
                self._add_durable(node)
            if self._is_logging_receiver(owner):
                self._add_logging(node)
            if isinstance(node.slice, ast.Constant) and isinstance(
                node.slice.value, str
            ):
                if node.slice.value in DURABLE_METHODS | FILE_METHODS:
                    self._add_durable(node)
                if node.slice.value in LOG_METHODS:
                    self._add_logging(node)
        if (
            isinstance(node.value, ast.Call)
            and self._canonical_name(node.value.func) == "vars"
            and node.value.args
        ):
            owner = node.value.args[0]
            method = (
                node.slice.value
                if isinstance(node.slice, ast.Constant)
                and isinstance(node.slice.value, str)
                else None
            )
            if method is None:
                self._add_durable(node)
                self._add_logging(node)
            if (
                self._is_durable_receiver(owner)
                or self._is_path_value(owner)
                or method in DURABLE_METHODS | FILE_METHODS
            ):
                self._add_durable(node)
            if self._is_logging_receiver(owner) or method in LOG_METHODS:
                self._add_logging(node)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        canonical = self._canonical_name(node.func)
        final = canonical.rsplit(".", 1)[-1] if canonical else None
        if isinstance(node.func, ast.Name) and node.func.id in self._print_aliases:
            self._add_logging(node)
        if isinstance(node.func, ast.Name) and self._identifier_is_logging(
            node.func.id
        ):
            self._add_logging(node)
        if final in DURABLE_CONSTRUCTORS:
            self._add_durable(node)
        if canonical in FILE_OPEN_CAPABILITIES:
            self._add_durable(node)
        if isinstance(node.func, ast.Name) and node.func.id in self._open_aliases:
            if _open_call_writes(node):
                self._add_durable(node)
        if isinstance(node.func, ast.Attribute) and node.func.attr == "open":
            if self._is_path_value(node.func.value) and _path_open_call_writes(node):
                self._add_durable(node)
        if final in {"getattr", "vars"} and node.args:
            receiver = node.args[0]
            method: str | None = None
            if len(node.args) >= 2 and isinstance(node.args[1], ast.Constant):
                method = node.args[1].value if isinstance(node.args[1].value, str) else None
            dynamic_method = final == "vars" or method is None
            if dynamic_method:
                self._add_durable(node)
                self._add_logging(node)
            if (
                self._is_durable_receiver(receiver)
                or self._is_path_value(receiver)
                or method in DURABLE_METHODS | FILE_METHODS
            ):
                self._add_durable(node)
            if self._is_logging_receiver(receiver) or method in LOG_METHODS:
                self._add_logging(node)
        self.generic_visit(node)


def python_project_findings(contents: dict[str, str]) -> dict[str, set[str]]:
    findings = {relative_path: set() for relative_path in contents}
    for relative_path, content in contents.items():
        try:
            tree = ast.parse(content)
        except (SyntaxError, ValueError):
            findings[relative_path].add("unparseable-production-python")
            continue
        allowed_durable, allowed_logging, attestation_findings = _attested_node_ids(
            relative_path, tree
        )
        findings[relative_path].update(attestation_findings)
        visitor = ArchitecturalSinkVisitor(
            allowed_durable=allowed_durable,
            allowed_logging=allowed_logging,
        )
        visitor.visit(tree)
        findings[relative_path].update(visitor.findings)
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
