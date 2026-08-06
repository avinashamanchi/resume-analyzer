#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ast
import re
import subprocess
import sys
from pathlib import Path


PRODUCTION_PREFIXES = ("server/", "static/", "contracts/")
PRODUCTION_FILES = {"app.py", "render.yaml", "Procfile"}
SENSITIVE_FIELDS = r"(?:resume_text|job_description|filename|pdf_base64)"
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

REQUEST_SOURCE_MEMBERS = frozenset(
    {
        "body",
        "cookies",
        "data",
        "files",
        "form",
        "get_data",
        "get_json",
        "headers",
        "json",
        "stream",
        "values",
    }
)
LOG_METHODS = frozenset(
    {"critical", "debug", "error", "exception", "info", "log", "warning"}
)
PERSISTENCE_METHODS = frozenset(
    {
        "append",
        "execute",
        "executemany",
        "hset",
        "insert",
        "lpush",
        "put",
        "rpush",
        "save",
        "set",
        "setex",
        "write",
        "write_bytes",
        "write_text",
    }
)
NEW_STORE_CALLS = frozenset(
    {
        "create_engine",
        "shelve.open",
        "sqlalchemy.create_engine",
        "sqlite3.connect",
    }
)
SENSITIVE_NAME_PATTERN = re.compile(
    r"(?:resume_text|job_description|filename|pdf_base64)",
    re.IGNORECASE,
)


def _dotted_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _dotted_name(node.value)
        return None if parent is None else f"{parent}.{node.attr}"
    return None


def _assigned_names(node: ast.AST) -> set[str]:
    if isinstance(node, ast.Name):
        return {node.id}
    if isinstance(node, (ast.List, ast.Tuple)):
        return set().union(*(_assigned_names(element) for element in node.elts))
    return set()


class PythonRetentionVisitor(ast.NodeVisitor):
    """Conservatively follow request content into logs and durable sinks."""

    def __init__(self) -> None:
        self.findings: set[str] = set()
        self._tainted_names: set[str] = set()
        self._sink_aliases: dict[str, str] = {}
        self._request_aliases: set[str] = {"request"}

    def _expression_is_request_object(self, node: ast.AST | None) -> bool:
        dotted = _dotted_name(node) if node is not None else None
        return dotted in self._request_aliases

    def _expression_is_tainted(self, node: ast.AST | None) -> bool:
        if node is None:
            return False
        for child in ast.walk(node):
            if isinstance(child, ast.Name) and (
                child.id in self._tainted_names
                or SENSITIVE_NAME_PATTERN.search(child.id)
            ):
                return True
            if isinstance(child, ast.Constant) and isinstance(child.value, str):
                if SENSITIVE_NAME_PATTERN.search(child.value):
                    return True
            dotted = _dotted_name(child)
            if dotted is not None:
                parts = dotted.split(".")
                if (
                    parts[0] in self._request_aliases
                    and any(part in REQUEST_SOURCE_MEMBERS for part in parts[1:])
                ):
                    return True
        return False

    def _sink_kind(self, node: ast.AST) -> str | None:
        dotted = _dotted_name(node)
        if dotted is None:
            return None
        if dotted in self._sink_aliases:
            return self._sink_aliases[dotted]
        final_name = dotted.rsplit(".", maxsplit=1)[-1]
        if dotted == "print" or final_name in LOG_METHODS:
            return "request-content-log"
        if "." in dotted and final_name in PERSISTENCE_METHODS:
            return "durable-content-sink"
        return None

    def _visit_function_scope(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        previous_taint = self._tainted_names
        previous_aliases = self._sink_aliases
        previous_request_aliases = self._request_aliases
        parameter_names = {
            argument.arg
            for argument in (
                *node.args.posonlyargs,
                *node.args.args,
                *node.args.kwonlyargs,
            )
        }
        if node.args.vararg is not None:
            parameter_names.add(node.args.vararg.arg)
        if node.args.kwarg is not None:
            parameter_names.add(node.args.kwarg.arg)
        self._tainted_names = set(previous_taint)
        self._tainted_names.update(
            name for name in parameter_names if SENSITIVE_NAME_PATTERN.search(name)
        )
        self._sink_aliases = dict(previous_aliases)
        self._request_aliases = set(previous_request_aliases)
        for statement in node.body:
            self.visit(statement)
        self._tainted_names = previous_taint
        self._sink_aliases = previous_aliases
        self._request_aliases = previous_request_aliases

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_function_scope(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_function_scope(node)

    def visit_Assign(self, node: ast.Assign) -> None:
        self.visit(node.value)
        names = set().union(*(_assigned_names(target) for target in node.targets))
        if self._expression_is_tainted(node.value):
            self._tainted_names.update(names)
        if self._expression_is_request_object(node.value):
            self._request_aliases.update(names)
        sink_kind = self._sink_kind(node.value)
        if sink_kind is not None:
            self._sink_aliases.update({name: sink_kind for name in names})
        if isinstance(node.value, ast.Call) and _dotted_name(node.value.func) == "open":
            if _open_call_writes(node.value):
                self.findings.add("new-server-retention-store")

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if node.value is None:
            return
        self.visit(node.value)
        names = _assigned_names(node.target)
        if self._expression_is_tainted(node.value):
            self._tainted_names.update(names)
        if self._expression_is_request_object(node.value):
            self._request_aliases.update(names)
        sink_kind = self._sink_kind(node.value)
        if sink_kind is not None:
            self._sink_aliases.update({name: sink_kind for name in names})
        if isinstance(node.value, ast.Call) and _dotted_name(node.value.func) == "open":
            if _open_call_writes(node.value):
                self.findings.add("new-server-retention-store")

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
        self.visit(node.value)
        if self._expression_is_tainted(node.value):
            self._tainted_names.update(_assigned_names(node.target))
        if self._expression_is_request_object(node.value):
            self._request_aliases.update(_assigned_names(node.target))

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.module == "flask":
            self._request_aliases.update(
                alias.asname or alias.name
                for alias in node.names
                if alias.name == "request"
            )

    def visit_Call(self, node: ast.Call) -> None:
        dotted = _dotted_name(node.func)
        if dotted in NEW_STORE_CALLS:
            self.findings.add("new-server-retention-store")
        if dotted == "open" and _open_call_writes(node):
            self.findings.add("new-server-retention-store")
        if isinstance(node.func, ast.Attribute):
            if node.func.attr in {"touch", "write_bytes", "write_text"}:
                self.findings.add("new-server-retention-store")
            if node.func.attr == "open" and _path_open_call_writes(node):
                self.findings.add("new-server-retention-store")
        sink_kind = self._sink_kind(node.func)
        values = (*node.args, *(keyword.value for keyword in node.keywords))
        if sink_kind is not None and any(
            self._expression_is_tainted(value) for value in values
        ):
            self.findings.add(sink_kind)
        self.generic_visit(node)


def _open_call_writes(node: ast.Call) -> bool:
    mode: str | None = None
    if len(node.args) >= 2 and isinstance(node.args[1], ast.Constant):
        mode = node.args[1].value if isinstance(node.args[1].value, str) else None
    for keyword in node.keywords:
        if keyword.arg == "mode" and isinstance(keyword.value, ast.Constant):
            mode = keyword.value.value if isinstance(keyword.value.value, str) else None
    return isinstance(mode, str) and any(marker in mode for marker in ("a", "w", "x", "+"))


def _path_open_call_writes(node: ast.Call) -> bool:
    mode: str | None = None
    if node.args and isinstance(node.args[0], ast.Constant):
        mode = node.args[0].value if isinstance(node.args[0].value, str) else None
    for keyword in node.keywords:
        if keyword.arg == "mode" and isinstance(keyword.value, ast.Constant):
            mode = keyword.value.value if isinstance(keyword.value.value, str) else None
    return isinstance(mode, str) and any(marker in mode for marker in ("a", "w", "x", "+"))


def python_findings(content: str) -> set[str]:
    try:
        parsed = ast.parse(content)
    except (SyntaxError, ValueError):
        return {"unparseable-production-python"}
    visitor = PythonRetentionVisitor()
    visitor.visit(parsed)
    return visitor.findings


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


def is_production_path(path: str) -> bool:
    return path in PRODUCTION_FILES or path.startswith(PRODUCTION_PREFIXES)


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    arguments = parser.parse_args()
    root = arguments.root.resolve()
    try:
        files = tracked_files(root)
    except RuntimeError:
        print(
            "Sensitive-retention verification failed: repository is unavailable.",
            file=sys.stderr,
        )
        return 2

    findings: list[tuple[str, str]] = []
    for relative_path in files:
        if not is_production_path(relative_path):
            continue
        path = root / relative_path
        try:
            content = path.read_text()
        except (OSError, UnicodeDecodeError):
            findings.append((relative_path, "unreadable-production-file"))
            continue
        if (
            relative_path == "app.py"
            or relative_path.startswith("server/")
        ) and relative_path.endswith(".py"):
            findings.extend(
                (relative_path, rule_name)
                for rule_name in sorted(python_findings(content))
            )
        for rule_name, pattern, applies in RULES:
            if applies(relative_path) and pattern.search(content):
                findings.append((relative_path, rule_name))

    if findings:
        print(
            f"Sensitive-retention verification failed: {len(findings)} prohibited production location"
            f"{'s' if len(findings) != 1 else ''}.",
            file=sys.stderr,
        )
        for relative_path, rule_name in findings:
            print(f"- {relative_path}: {rule_name}", file=sys.stderr)
        return 1

    print("Sensitive-retention verification passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
