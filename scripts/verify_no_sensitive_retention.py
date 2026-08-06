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
REDIS_PERSISTENCE_METHODS = frozenset(
    {
        "append",
        "hset",
        "lpush",
        "mset",
        "put",
        "rpush",
        "sadd",
        "set",
        "setex",
        "xadd",
        "zadd",
    }
)
DATABASE_PERSISTENCE_METHODS = frozenset(
    {
        "add",
        "add_all",
        "bulk_save_objects",
        "execute",
        "executemany",
        "insert",
        "merge",
        "put",
        "save",
    }
)
FILE_PERSISTENCE_METHODS = frozenset({"write", "writelines"})
PATH_PERSISTENCE_METHODS = frozenset({"touch", "write_bytes", "write_text"})
SHELVE_PERSISTENCE_METHODS = frozenset({"setdefault", "update"})
LOCAL_MUTATION_METHODS = frozenset(
    {"append", "extend", "insert", "put", "write", "writelines"}
)
DURABLE_RECEIVER_KINDS = frozenset(
    {"database", "file", "output", "path", "redis", "shelve"}
)
LOCAL_RECEIVER_CONSTRUCTORS = frozenset(
    {
        "BytesIO",
        "LifoQueue",
        "PriorityQueue",
        "Queue",
        "SimpleQueue",
        "StringIO",
        "bytearray",
        "deque",
        "dict",
        "list",
        "set",
    }
)
SENSITIVE_NAME_PATTERN = re.compile(
    r"(?:resume_text|job_description|filename|pdf_base64)",
    re.IGNORECASE,
)
REDIS_RECEIVER_PATTERN = re.compile(r"(?:^|_)redis(?:_|$)", re.IGNORECASE)
DATABASE_RECEIVER_PATTERN = re.compile(
    r"(?:^|_)(?:db|database|sql|sqlite|sqlalchemy)(?:_|$)", re.IGNORECASE
)
DATABASE_RECEIVER_NAMES = frozenset({"connection", "cursor", "engine", "session"})
SHELVE_RECEIVER_PATTERN = re.compile(r"(?:^|_)(?:shelf|shelve)(?:_|$)", re.IGNORECASE)

AccessPath = tuple[str, ...]
WILDCARD_SUBSCRIPT_COMPONENT = "key:*"


def _dotted_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _dotted_name(node.value)
        return None if parent is None else f"{parent}.{node.attr}"
    return None


def _subscript_component(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, (str, int)):
        return f"key:{type(node.value).__name__}:{node.value!r}"
    return None


def _access_path(node: ast.AST | None) -> AccessPath | None:
    if isinstance(node, ast.Name):
        return (node.id,)
    if isinstance(node, ast.Attribute):
        parent = _access_path(node.value)
        return None if parent is None else (*parent, f"attr:{node.attr}")
    if isinstance(node, ast.Subscript):
        parent = _access_path(node.value)
        component = _subscript_component(node.slice)
        if parent is None or component is None:
            return None
        return (*parent, component)
    return None


def _call_lookup_path(node: ast.AST | None) -> AccessPath | None:
    if (
        not isinstance(node, ast.Call)
        or not isinstance(node.func, ast.Attribute)
        or node.func.attr != "get"
        or not node.args
    ):
        return None
    parent = _access_path(node.func.value)
    component = _subscript_component(node.args[0])
    if parent is None or component is None:
        return None
    return (*parent, component)


def _assigned_paths(node: ast.AST) -> set[AccessPath]:
    path = _access_path(node)
    if path is not None:
        return {path}
    if isinstance(node, (ast.List, ast.Tuple)):
        return set().union(*(_assigned_paths(element) for element in node.elts))
    return set()


def _path_is_prefix(prefix: AccessPath, path: AccessPath) -> bool:
    return len(prefix) <= len(path) and path[: len(prefix)] == prefix


def _path_matches(pattern: AccessPath, path: AccessPath) -> bool:
    return len(pattern) == len(path) and all(
        expected == actual or expected == WILDCARD_SUBSCRIPT_COMPONENT
        for expected, actual in zip(pattern, path, strict=True)
    )


def _path_identifier(path: AccessPath) -> str:
    final = path[-1]
    return final.removeprefix("attr:") if final.startswith("attr:") else final


class PythonRetentionVisitor(ast.NodeVisitor):
    """Conservatively follow request content into logs and durable sinks."""

    def __init__(
        self,
        tainted_functions: set[str] | None = None,
        request_functions: set[str] | None = None,
        *,
        module_name: str = "app",
        project_modules: set[str] | None = None,
        local_callable_names: set[str] | None = None,
    ) -> None:
        self.findings: set[str] = set()
        self._tainted_paths: set[AccessPath] = set()
        self._sink_aliases: dict[AccessPath, str] = {}
        self._request_paths: set[AccessPath] = {("request",)}
        self._durable_receivers: dict[AccessPath, str] = {}
        self._callable_factories: dict[AccessPath, str] = {}
        self._callable_aliases: dict[AccessPath, str] = {}
        self._module_aliases: dict[AccessPath, str] = {}
        self._bound_paths: set[AccessPath] = set()
        self._flask_module_aliases: set[str] = {"flask"}
        self._path_constructor_aliases: set[str] = {"Path"}
        self.tainted_functions: set[str] = set(tainted_functions or ())
        self.request_functions: set[str] = set(request_functions or ())
        self._module_name = module_name
        self._project_modules = set(project_modules or ())
        self._function_stack: list[str] = []
        for name in local_callable_names or ():
            path = (name,)
            self._bound_paths.add(path)
            self._callable_factories[path] = "local"
            self._callable_aliases[path] = f"{self._module_name}.{name}"

    def _path_is_request_object(self, path: AccessPath | None) -> bool:
        if path is None:
            return False
        if any(_path_matches(request_path, path) for request_path in self._request_paths):
            return True
        return (
            len(path) == 2
            and path[0] in self._flask_module_aliases
            and path[1] == "attr:request"
        )

    def _callable_identity(self, node: ast.AST) -> str | None:
        path = _access_path(node)
        if path is not None and path in self._callable_aliases:
            return self._callable_aliases[path]
        canonical_member = self._canonical_module_member(node)
        if canonical_member is not None:
            return canonical_member
        if isinstance(node, ast.Attribute):
            local_candidate = f"{self._module_name}.{node.attr}"
            if (
                local_candidate in self.tainted_functions
                or local_candidate in self.request_functions
            ):
                return local_candidate
        return None

    def _summary_contains(self, node: ast.Call, summaries: set[str]) -> bool:
        identity = self._callable_identity(node.func)
        return identity is not None and identity in summaries

    def _expression_is_request_object(self, node: ast.AST | None) -> bool:
        if node is None:
            return False
        path = _access_path(node)
        if self._path_is_request_object(path):
            return True
        if self._path_is_request_object(_call_lookup_path(node)):
            return True
        return isinstance(node, ast.Call) and self._summary_contains(
            node, self.request_functions
        )

    def _call_returns_tainted(self, node: ast.Call) -> bool:
        return self._summary_contains(node, self.tainted_functions)

    def _path_is_tainted(self, path: AccessPath) -> bool:
        return any(
            _path_is_prefix(tainted, path) or _path_is_prefix(path, tainted)
            for tainted in self._tainted_paths
        )

    def _path_reads_request_content(self, path: AccessPath) -> bool:
        for index in range(1, len(path)):
            member = path[index]
            if not member.startswith("attr:"):
                continue
            if (
                self._path_is_request_object(path[:index])
                and member.removeprefix("attr:") in REQUEST_SOURCE_MEMBERS
            ):
                return True
        return False

    def _expression_is_tainted(self, node: ast.AST | None) -> bool:
        if node is None:
            return False

        path = _access_path(node)
        if path is not None:
            return (
                self._path_is_tainted(path)
                or self._path_reads_request_content(path)
                or any(SENSITIVE_NAME_PATTERN.search(component) for component in path)
            )

        if isinstance(node, ast.Constant):
            return isinstance(node.value, str) and bool(
                SENSITIVE_NAME_PATTERN.search(node.value)
            )

        if isinstance(node, ast.Call):
            if self._call_returns_tainted(node):
                return True
            lookup_path = _call_lookup_path(node)
            if lookup_path is not None:
                return (
                    self._path_is_tainted(lookup_path)
                    or self._path_reads_request_content(lookup_path)
                    or any(
                        SENSITIVE_NAME_PATTERN.search(component)
                        for component in lookup_path
                    )
                    or any(
                        self._expression_is_tainted(value)
                        for value in (
                            *node.args[1:],
                            *(keyword.value for keyword in node.keywords),
                        )
                    )
                )
            if isinstance(node.func, ast.Attribute):
                if (
                    node.func.attr in REQUEST_SOURCE_MEMBERS
                    and self._expression_is_request_object(node.func.value)
                ):
                    return True
                if self._expression_is_tainted(node.func.value):
                    return True
            return any(
                self._expression_is_tainted(value)
                for value in (*node.args, *(keyword.value for keyword in node.keywords))
            )

        if isinstance(node, ast.Attribute):
            if (
                node.attr in REQUEST_SOURCE_MEMBERS
                and self._expression_is_request_object(node.value)
            ):
                return True
            return self._expression_is_tainted(node.value)

        if isinstance(node, ast.Subscript):
            return self._expression_is_tainted(node.value)

        return any(
            self._expression_is_tainted(child) for child in ast.iter_child_nodes(node)
        )

    def _receiver_kind_for_path(self, path: AccessPath | None) -> str | None:
        if path is None:
            return None
        if path in self._durable_receivers:
            return self._durable_receivers[path]
        if (
            len(path) >= 2
            and self._module_aliases.get(path[:-1]) == "sys"
            and path[-1] in {"attr:stderr", "attr:stdout"}
        ):
            return "output"
        identifier = _path_identifier(path)
        if REDIS_RECEIVER_PATTERN.search(identifier):
            return "redis"
        if DATABASE_RECEIVER_PATTERN.search(identifier):
            return "database"
        if identifier.casefold() in DATABASE_RECEIVER_NAMES:
            return "database"
        if SHELVE_RECEIVER_PATTERN.search(identifier):
            return "shelve"
        return None

    def _canonical_module_member(self, node: ast.AST) -> str | None:
        path = _access_path(node)
        if path is None or len(path) < 2 or not path[-1].startswith("attr:"):
            return None
        for prefix_length in range(len(path) - 1, 0, -1):
            module = self._module_aliases.get(path[:prefix_length])
            if module is None:
                continue
            members = [
                component.removeprefix("attr:")
                for component in path[prefix_length:]
                if component.startswith("attr:")
            ]
            if len(members) != len(path) - prefix_length:
                return None
            return ".".join((module, *members))
        return None

    def _callable_factory_kind(self, node: ast.AST | None) -> str | None:
        if node is None:
            return None
        path = _access_path(node)
        if path is not None and path in self._callable_factories:
            return self._callable_factories[path]
        canonical_member = self._canonical_module_member(node)
        dotted = canonical_member or _dotted_name(node)
        if dotted == "open":
            return "file" if path not in self._bound_paths else None
        if canonical_member in {"builtins.open", "io.open"}:
            return "file"
        if canonical_member == "shelve.open":
            return "shelve"
        if dotted in {"sqlite3.connect", "create_engine", "sqlalchemy.create_engine"}:
            return "database"
        final_name = dotted.rsplit(".", maxsplit=1)[-1] if dotted else None
        if final_name in LOCAL_RECEIVER_CONSTRUCTORS:
            return "local"
        if final_name in {"Redis", "StrictRedis"}:
            return "redis"
        if final_name in self._path_constructor_aliases:
            return "path"
        return None

    def _expression_durable_kind(self, node: ast.AST | None) -> str | None:
        if node is None:
            return None
        path_kind = self._receiver_kind_for_path(_access_path(node))
        if path_kind is not None:
            return path_kind
        if isinstance(
            node,
            (
                ast.Dict,
                ast.DictComp,
                ast.List,
                ast.ListComp,
                ast.Set,
                ast.SetComp,
                ast.Tuple,
            ),
        ):
            return "local"
        if not isinstance(node, ast.Call):
            return None
        factory_kind = self._callable_factory_kind(node.func)
        if factory_kind == "file":
            return "file" if _open_call_writes(node) else None
        if factory_kind is not None:
            return factory_kind
        if isinstance(node.func, ast.Attribute):
            receiver_kind = self._expression_durable_kind(node.func.value)
            if receiver_kind == "redis" and node.func.attr in {"from_url", "pipeline"}:
                return "redis"
            if receiver_kind == "database" and node.func.attr in {
                "begin",
                "connect",
                "cursor",
                "session",
            }:
                return "database"
            if (
                receiver_kind == "path"
                and node.func.attr == "open"
                and _path_open_call_writes(node)
            ):
                return "file"
        return None

    def _sink_kind(self, node: ast.AST) -> str | None:
        path = _access_path(node)
        if path is not None and path in self._sink_aliases:
            return self._sink_aliases[path]
        dotted = _dotted_name(node)
        final_name = dotted.rsplit(".", maxsplit=1)[-1] if dotted else None
        if dotted == "print" or final_name in LOG_METHODS:
            return "request-content-log"
        if isinstance(node, ast.Attribute):
            receiver_kind = self._expression_durable_kind(node.value)
            methods_by_kind = {
                "database": DATABASE_PERSISTENCE_METHODS,
                "file": FILE_PERSISTENCE_METHODS,
                "output": frozenset(),
                "path": PATH_PERSISTENCE_METHODS,
                "redis": REDIS_PERSISTENCE_METHODS,
                "shelve": SHELVE_PERSISTENCE_METHODS,
            }
            if (
                receiver_kind == "output"
                and node.attr in FILE_PERSISTENCE_METHODS
            ):
                return "request-content-log"
            if node.attr in methods_by_kind.get(receiver_kind, frozenset()):
                return "durable-content-sink"
        return None

    def _clear_target(self, path: AccessPath) -> None:
        self._tainted_paths = {
            candidate
            for candidate in self._tainted_paths
            if not _path_is_prefix(path, candidate)
        }
        self._request_paths = {
            candidate
            for candidate in self._request_paths
            if not _path_is_prefix(path, candidate)
        }
        self._sink_aliases = {
            candidate: kind
            for candidate, kind in self._sink_aliases.items()
            if not _path_is_prefix(path, candidate)
        }
        self._durable_receivers = {
            candidate: kind
            for candidate, kind in self._durable_receivers.items()
            if not _path_is_prefix(path, candidate)
        }
        self._callable_factories = {
            candidate: kind
            for candidate, kind in self._callable_factories.items()
            if not _path_is_prefix(path, candidate)
        }
        self._callable_aliases = {
            candidate: identity
            for candidate, identity in self._callable_aliases.items()
            if not _path_is_prefix(path, candidate)
        }
        self._module_aliases = {
            candidate: module
            for candidate, module in self._module_aliases.items()
            if not _path_is_prefix(path, candidate)
        }
        self._bound_paths = {
            candidate
            for candidate in self._bound_paths
            if not _path_is_prefix(path, candidate)
        }
        if len(path) == 1:
            self._flask_module_aliases.discard(path[0])
            self._path_constructor_aliases.discard(path[0])

    def _copy_taint_paths(self, target: AccessPath, source: AccessPath) -> bool:
        copied = False
        for tainted in tuple(self._tainted_paths):
            if _path_is_prefix(tainted, source):
                self._tainted_paths.add(target)
                copied = True
            elif _path_is_prefix(source, tainted):
                self._tainted_paths.add((*target, *tainted[len(source) :]))
                copied = True
        return copied

    def _copy_request_paths(self, target: AccessPath, source: AccessPath) -> None:
        for request_path in tuple(self._request_paths):
            if request_path == source:
                self._request_paths.add(target)
            elif _path_is_prefix(source, request_path):
                self._request_paths.add((*target, *request_path[len(source) :]))

    def _propagate_structured_value(
        self, target: AccessPath, value: ast.AST
    ) -> bool:
        if isinstance(value, ast.Dict):
            for key, item in zip(value.keys, value.values, strict=True):
                component = _subscript_component(key) if key is not None else None
                if component is None:
                    if self._expression_is_tainted(item):
                        self._tainted_paths.add(target)
                    if self._expression_is_request_object(item):
                        self._request_paths.add(target)
                else:
                    self._propagate_value((*target, component), item)
            return True
        if isinstance(value, (ast.List, ast.Tuple)):
            for index, item in enumerate(value.elts):
                component = f"key:int:{index!r}"
                self._propagate_value((*target, component), item)
            return True
        return False

    def _propagate_value(self, target: AccessPath, value: ast.AST) -> None:
        if self._propagate_structured_value(target, value):
            self._durable_receivers[target] = "local"
            return
        source = _access_path(value)
        copied_taint = False
        if source is not None:
            copied_taint = self._copy_taint_paths(target, source)
            self._copy_request_paths(target, source)
        if self._expression_is_request_object(value):
            self._request_paths.add(target)
        if self._expression_is_tainted(value) and not copied_taint:
            self._tainted_paths.add(target)
        durable_kind = self._expression_durable_kind(value)
        if durable_kind is not None:
            self._durable_receivers[target] = durable_kind
        factory_kind = self._callable_factory_kind(value)
        if factory_kind is not None:
            self._callable_factories[target] = factory_kind
        if source is not None and source in self._module_aliases:
            self._module_aliases[target] = self._module_aliases[source]
        if source is not None and source in self._callable_aliases:
            self._callable_aliases[target] = self._callable_aliases[source]
        sink_kind = self._sink_kind(value)
        if sink_kind is not None:
            self._sink_aliases[target] = sink_kind
        if (
            len(target) == 1
            and isinstance(value, ast.Name)
            and value.id in self._flask_module_aliases
        ):
            self._flask_module_aliases.add(target[0])

    def _assign_target(self, target: ast.AST, value: ast.AST) -> None:
        if (
            isinstance(target, (ast.List, ast.Tuple))
            and isinstance(value, (ast.List, ast.Tuple))
            and len(target.elts) == len(value.elts)
        ):
            for destination, item in zip(target.elts, value.elts, strict=True):
                self._assign_target(destination, item)
            return
        for path in _assigned_paths(target):
            self._clear_target(path)
            self._propagate_value(path, value)
            self._bound_paths.add(path)

    def _bind_local_callable(self, name: str) -> None:
        path = (name,)
        self._clear_target(path)
        self._bound_paths.add(path)
        self._callable_factories[path] = "local"
        self._callable_aliases[path] = f"{self._module_name}.{name}"

    def _bind_import(self, name: str) -> AccessPath:
        path = (name,)
        self._clear_target(path)
        self._bound_paths.add(path)
        return path

    def _record_durable_subscript_assignment(
        self, target: ast.AST, value: ast.AST
    ) -> None:
        if (
            isinstance(target, ast.Subscript)
            and self._expression_durable_kind(target.value) == "shelve"
            and self._expression_is_tainted(value)
        ):
            self.findings.add("durable-content-sink")

    def _visit_function_scope(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        previous_taint = self._tainted_paths
        previous_aliases = self._sink_aliases
        previous_request_paths = self._request_paths
        previous_receivers = self._durable_receivers
        previous_factories = self._callable_factories
        previous_callables = self._callable_aliases
        previous_modules = self._module_aliases
        previous_bound_paths = self._bound_paths
        previous_flask_aliases = self._flask_module_aliases
        previous_path_aliases = self._path_constructor_aliases
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
        self._tainted_paths = set(previous_taint)
        self._sink_aliases = dict(previous_aliases)
        self._request_paths = set(previous_request_paths)
        self._durable_receivers = dict(previous_receivers)
        self._callable_factories = dict(previous_factories)
        self._callable_aliases = dict(previous_callables)
        self._module_aliases = dict(previous_modules)
        self._bound_paths = set(previous_bound_paths)
        self._flask_module_aliases = set(previous_flask_aliases)
        self._path_constructor_aliases = set(previous_path_aliases)
        for name in parameter_names:
            path = (name,)
            self._clear_target(path)
            self._bound_paths.add(path)
            if name == "request":
                self._request_paths.add(path)
        self._tainted_paths.update(
            (name,) for name in parameter_names if SENSITIVE_NAME_PATTERN.search(name)
        )
        self._function_stack.append(node.name)
        for statement in node.body:
            self.visit(statement)
        self._function_stack.pop()
        self._tainted_paths = previous_taint
        self._sink_aliases = previous_aliases
        self._request_paths = previous_request_paths
        self._durable_receivers = previous_receivers
        self._callable_factories = previous_factories
        self._callable_aliases = previous_callables
        self._module_aliases = previous_modules
        self._bound_paths = previous_bound_paths
        self._flask_module_aliases = previous_flask_aliases
        self._path_constructor_aliases = previous_path_aliases

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._bind_local_callable(node.name)
        self._visit_function_scope(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._bind_local_callable(node.name)
        self._visit_function_scope(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        for expression in (*node.decorator_list, *node.bases):
            self.visit(expression)
        for keyword in node.keywords:
            self.visit(keyword.value)
        self._bind_local_callable(node.name)
        previous_taint = self._tainted_paths
        previous_aliases = self._sink_aliases
        previous_request_paths = self._request_paths
        previous_receivers = self._durable_receivers
        previous_factories = self._callable_factories
        previous_callables = self._callable_aliases
        previous_modules = self._module_aliases
        previous_bound_paths = self._bound_paths
        previous_flask_aliases = self._flask_module_aliases
        previous_path_aliases = self._path_constructor_aliases
        self._tainted_paths = set(previous_taint)
        self._sink_aliases = dict(previous_aliases)
        self._request_paths = set(previous_request_paths)
        self._durable_receivers = dict(previous_receivers)
        self._callable_factories = dict(previous_factories)
        self._callable_aliases = dict(previous_callables)
        self._module_aliases = dict(previous_modules)
        self._bound_paths = set(previous_bound_paths)
        self._flask_module_aliases = set(previous_flask_aliases)
        self._path_constructor_aliases = set(previous_path_aliases)
        for statement in node.body:
            self.visit(statement)
        self._tainted_paths = previous_taint
        self._sink_aliases = previous_aliases
        self._request_paths = previous_request_paths
        self._durable_receivers = previous_receivers
        self._callable_factories = previous_factories
        self._callable_aliases = previous_callables
        self._module_aliases = previous_modules
        self._bound_paths = previous_bound_paths
        self._flask_module_aliases = previous_flask_aliases
        self._path_constructor_aliases = previous_path_aliases

    def visit_Assign(self, node: ast.Assign) -> None:
        self.visit(node.value)
        for target in node.targets:
            self._record_durable_subscript_assignment(target, node.value)
            self._assign_target(target, node.value)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if node.value is None:
            return
        self.visit(node.value)
        self._record_durable_subscript_assignment(node.target, node.value)
        self._assign_target(node.target, node.value)

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
        self.visit(node.value)
        self._assign_target(node.target, node.value)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        target_tainted = self._expression_is_tainted(node.target)
        value_tainted = self._expression_is_tainted(node.value)
        self.visit(node.value)
        for path in _assigned_paths(node.target):
            self._clear_target(path)
            if target_tainted or value_tainted:
                self._tainted_paths.add(path)
            self._bound_paths.add(path)

    def visit_Return(self, node: ast.Return) -> None:
        if self._function_stack and self._expression_is_tainted(node.value):
            self.tainted_functions.add(
                f"{self._module_name}.{self._function_stack[-1]}"
            )
        if self._function_stack and self._expression_is_request_object(node.value):
            self.request_functions.add(
                f"{self._module_name}.{self._function_stack[-1]}"
            )
        if node.value is not None:
            self.visit(node.value)

    def visit_Import(self, node: ast.Import) -> None:
        tracked_modules = {"builtins", "io", "shelve", "sys"}
        for alias in node.names:
            target_name = alias.asname or alias.name.split(".", maxsplit=1)[0]
            target = self._bind_import(target_name)
            bound_module = alias.name if alias.asname else alias.name.split(".", 1)[0]
            if alias.name in tracked_modules or alias.name in self._project_modules:
                self._module_aliases[target] = bound_module
            if alias.name == "flask":
                self._flask_module_aliases.add(target_name)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        imported_module = self._resolve_import_from_module(node)
        for alias in node.names:
            if alias.name == "*":
                continue
            target = self._bind_import(alias.asname or alias.name)
            if node.module == "flask" and alias.name == "request":
                self._request_paths.add(target)
            elif node.module == "pathlib" and alias.name == "Path":
                self._callable_factories[target] = "path"
            elif node.module == "sys" and alias.name in {"stderr", "stdout"}:
                self._durable_receivers[target] = "output"
            elif node.module == "shelve" and alias.name == "open":
                self._callable_factories[target] = "shelve"
            elif node.module in {"builtins", "io"} and alias.name == "open":
                self._callable_factories[target] = "file"
            elif node.module == "io" and alias.name in LOCAL_RECEIVER_CONSTRUCTORS:
                self._callable_factories[target] = "local"
            if imported_module in self._project_modules:
                self._callable_aliases[target] = f"{imported_module}.{alias.name}"

    def _resolve_import_from_module(self, node: ast.ImportFrom) -> str:
        if node.level == 0:
            return node.module or ""
        package = self._module_name.split(".")[:-1]
        ascend = max(node.level - 1, 0)
        if ascend:
            package = package[:-ascend]
        if node.module:
            package.extend(node.module.split("."))
        return ".".join(package)

    def _visit_with(self, node: ast.With | ast.AsyncWith) -> None:
        for item in node.items:
            self.visit(item.context_expr)
            if item.optional_vars is not None:
                self._assign_target(item.optional_vars, item.context_expr)
        for statement in node.body:
            self.visit(statement)

    def visit_With(self, node: ast.With) -> None:
        self._visit_with(node)

    def visit_AsyncWith(self, node: ast.AsyncWith) -> None:
        self._visit_with(node)

    def visit_Delete(self, node: ast.Delete) -> None:
        for target in node.targets:
            for path in _assigned_paths(target):
                self._clear_target(path)

    def visit_Call(self, node: ast.Call) -> None:
        factory_kind = self._callable_factory_kind(node.func)
        if factory_kind in {"database", "shelve"}:
            self.findings.add("new-server-retention-store")
        if factory_kind == "file" and _open_call_writes(node):
            self.findings.add("new-server-retention-store")
        receiver_kind = None
        if isinstance(node.func, ast.Attribute):
            receiver_kind = self._expression_durable_kind(node.func.value)
            if (
                receiver_kind == "path"
                and node.func.attr in PATH_PERSISTENCE_METHODS
            ):
                self.findings.add("new-server-retention-store")
            if (
                receiver_kind == "path"
                and node.func.attr == "open"
                and _path_open_call_writes(node)
            ):
                self.findings.add("new-server-retention-store")
        sink_kind = self._sink_kind(node.func)
        values = (*node.args, *(keyword.value for keyword in node.keywords))
        has_tainted_value = any(self._expression_is_tainted(value) for value in values)
        if sink_kind is not None and has_tainted_value:
            self.findings.add(sink_kind)
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr in LOCAL_MUTATION_METHODS
            and receiver_kind not in DURABLE_RECEIVER_KINDS
            and has_tainted_value
        ):
            receiver_path = _access_path(node.func.value)
            if receiver_path is not None:
                self._tainted_paths.add(receiver_path)
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr in {"append", "put"}
            and any(self._expression_is_request_object(value) for value in values)
        ):
            receiver_path = _access_path(node.func.value)
            if receiver_path is not None:
                self._request_paths.add(
                    (*receiver_path, WILDCARD_SUBSCRIPT_COMPONENT)
                )
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


def _module_name(relative_path: str) -> str:
    path = relative_path.removesuffix(".py").replace("/", ".")
    return path.removesuffix(".__init__")


def python_project_findings(contents: dict[str, str]) -> dict[str, set[str]]:
    parsed_modules: dict[str, ast.Module] = {}
    findings = {relative_path: set() for relative_path in contents}
    modules_by_path = {
        relative_path: _module_name(relative_path) for relative_path in contents
    }
    for relative_path, content in contents.items():
        try:
            parsed_modules[relative_path] = ast.parse(content)
        except (SyntaxError, ValueError):
            findings[relative_path].add("unparseable-production-python")

    project_modules = set(modules_by_path.values())
    tainted_functions: set[str] = set()
    request_functions: set[str] = set()
    function_count = sum(
        isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        for parsed in parsed_modules.values()
        for node in ast.walk(parsed)
    )
    for _ in range(function_count + 1):
        discovered_tainted = set(tainted_functions)
        discovered_request = set(request_functions)
        for relative_path, parsed in parsed_modules.items():
            visitor = PythonRetentionVisitor(
                tainted_functions,
                request_functions,
                module_name=modules_by_path[relative_path],
                project_modules=project_modules,
                local_callable_names={
                    node.name
                    for node in parsed.body
                    if isinstance(
                        node,
                        (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef),
                    )
                },
            )
            visitor.visit(parsed)
            findings[relative_path].update(visitor.findings)
            discovered_tainted.update(visitor.tainted_functions)
            discovered_request.update(visitor.request_functions)
        if (
            discovered_tainted == tainted_functions
            and discovered_request == request_functions
        ):
            break
        tainted_functions = discovered_tainted
        request_functions = discovered_request
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
    production_contents: dict[str, str] = {}
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
            production_contents[relative_path] = content
        for rule_name, pattern, applies in RULES:
            if applies(relative_path) and pattern.search(content):
                findings.append((relative_path, rule_name))

    for relative_path, rules in python_project_findings(production_contents).items():
        findings.extend(
            (relative_path, rule_name) for rule_name in sorted(rules)
        )

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
