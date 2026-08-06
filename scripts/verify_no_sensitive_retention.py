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
PARAMETER_IDENTITY_PREFIX = "$project-parameter$"


def _parameter_identity(owner: str, name: str) -> str:
    return f"{PARAMETER_IDENTITY_PREFIX}{owner}${name}"


def _parameter_details(identity: str) -> tuple[str, str] | None:
    if not identity.startswith(PARAMETER_IDENTITY_PREFIX):
        return None
    owner, separator, name = identity.removeprefix(PARAMETER_IDENTITY_PREFIX).rpartition(
        "$"
    )
    return (owner, name) if separator else None


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
        safe_functions: set[str] | None = None,
        callable_returns: dict[str, set[str]] | None = None,
        *,
        module_name: str = "app",
        project_modules: set[str] | None = None,
        project_callables: set[str] | None = None,
        initial_callables: dict[str, str] | None = None,
        public_callables: dict[str, str] | None = None,
        class_members: dict[tuple[str, str], str] | None = None,
        class_identities: set[str] | None = None,
        node_identities: dict[int, str] | None = None,
        module_exports: dict[str, dict[str, str]] | None = None,
        callable_parameter_sinks: dict[str, dict[str, set[str]]] | None = None,
        callable_parameters: dict[str, tuple[str, ...]] | None = None,
        callable_defaults: dict[str, dict[str, str]] | None = None,
        callable_variadics: dict[str, tuple[str | None, str | None]] | None = None,
        class_member_bindings: dict[str, str] | None = None,
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
        self.safe_functions: set[str] = set(safe_functions or ())
        self.callable_returns: dict[str, set[str]] = {
            identity: set(returns)
            for identity, returns in (callable_returns or {}).items()
        }
        self._module_name = module_name
        self._project_modules = set(project_modules or ())
        self._project_callables = set(project_callables or ())
        self._public_callables = dict(public_callables or {})
        self._class_members = dict(class_members or {})
        self._class_identities = set(class_identities or ())
        self._node_identities = dict(node_identities or {})
        self._module_exports = {
            module: dict(exports) for module, exports in (module_exports or {}).items()
        }
        self.callable_parameter_sinks = {
            identity: {name: set(kinds) for name, kinds in parameters.items()}
            for identity, parameters in (callable_parameter_sinks or {}).items()
        }
        self.callable_parameters = dict(callable_parameters or {})
        self.callable_defaults = {
            identity: dict(defaults)
            for identity, defaults in (callable_defaults or {}).items()
        }
        self.callable_variadics = dict(callable_variadics or {})
        self._class_member_bindings = dict(class_member_bindings or {})
        self._function_stack: list[str] = []
        self._parameter_stack: list[set[str]] = []
        self._scope_stack: list[str] = []
        self._function_return_states: dict[str, set[str]] = {}
        self._callable_transforms: dict[AccessPath, str] = {}
        self._bound_instances: set[AccessPath] = set()
        for name, identity in (initial_callables or {}).items():
            path = (name,)
            self._bound_paths.add(path)
            self._callable_factories[path] = "local"
            self._callable_aliases[path] = identity

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
        if path is not None:
            for pattern, identity in self._callable_aliases.items():
                if WILDCARD_SUBSCRIPT_COMPONENT in pattern and _path_matches(
                    pattern, path
                ):
                    return identity
        canonical_member = self._canonical_module_member(node)
        if canonical_member is not None:
            resolved = self._public_callables.get(canonical_member)
            if resolved is not None:
                return resolved
        if isinstance(node, ast.Attribute):
            receiver_identity: str | None = None
            if isinstance(node.value, ast.Call):
                receiver_identity = self._callable_identity(node.value.func)
            else:
                receiver_identity = self._callable_identity(node.value)
            if receiver_identity is not None:
                if node.attr == "__call__" and _parameter_details(
                    receiver_identity
                ) is not None:
                    return receiver_identity
                member = self._class_members.get((receiver_identity, node.attr))
                if member is not None:
                    return member
        return None

    def _register_lambda(self, node: ast.Lambda) -> str:
        scope = ".".join(self._scope_stack)
        prefix = f"{self._module_name}.{scope}." if scope else f"{self._module_name}."
        identity = self._node_identities.get(
            id(node), f"{prefix}<lambda>@{node.lineno}:{node.col_offset}"
        )
        self._project_callables.add(identity)
        positional = (*node.args.posonlyargs, *node.args.args)
        self.callable_parameters[identity] = tuple(
            argument.arg for argument in (*positional, *node.args.kwonlyargs)
        )
        self.callable_variadics[identity] = (
            node.args.vararg.arg if node.args.vararg is not None else None,
            node.args.kwarg.arg if node.args.kwarg is not None else None,
        )
        parameter_names = {
            argument.arg
            for argument in (
                *positional,
                *node.args.kwonlyargs,
            )
        }
        if node.args.vararg is not None:
            parameter_names.add(node.args.vararg.arg)
        if node.args.kwarg is not None:
            parameter_names.add(node.args.kwarg.arg)
        for candidate in ast.walk(node.body):
            if not isinstance(candidate, ast.Call):
                continue
            sink_kind = self._sink_kind(candidate.func)
            if sink_kind is None:
                continue
            values = (
                *candidate.args,
                *(keyword.value for keyword in candidate.keywords),
            )
            for value in values:
                for callback_call in ast.walk(value):
                    if not isinstance(callback_call, ast.Call):
                        continue
                    callback = callback_call.func
                    if isinstance(callback, ast.Attribute) and callback.attr == "__call__":
                        callback = callback.value
                    path = _access_path(callback)
                    if path is not None and path[0] in parameter_names:
                        summaries = self.callable_parameter_sinks.setdefault(identity, {})
                        summaries.setdefault(path[0], set()).add(sink_kind)
        if self._expression_is_request_object(node.body):
            self.request_functions.add(identity)
        if self._expression_is_tainted(node.body):
            self.tainted_functions.add(identity)
        elif self._expression_is_demonstrably_safe(node.body):
            self.safe_functions.add(identity)
        return identity

    def _merged_callable_identity(
        self, node: ast.AST, identities: list[str], kind: str
    ) -> str | None:
        if not identities:
            return None
        if len(set(identities)) == 1:
            return identities[0]
        scope = ".".join(self._scope_stack)
        prefix = f"{self._module_name}.{scope}." if scope else f"{self._module_name}."
        identity = f"{prefix}<{kind}>@{node.lineno}:{node.col_offset}"
        self._project_callables.add(identity)
        if any(item in self.request_functions for item in identities):
            self.request_functions.add(identity)
        if any(item in self.tainted_functions for item in identities):
            self.tainted_functions.add(identity)
        elif all(item in self.safe_functions for item in identities):
            self.safe_functions.add(identity)
        return identity

    def _callable_transform_kind(self, node: ast.AST) -> str | None:
        path = _access_path(node)
        if path is not None and path in self._callable_transforms:
            return self._callable_transforms[path]
        canonical = self._canonical_module_member(node)
        dotted = canonical or _dotted_name(node)
        if dotted == "getattr" and path not in self._bound_paths:
            return "getattr"
        if dotted == "vars" and path not in self._bound_paths:
            return "vars"
        return {
            "builtins.getattr": "getattr",
            "functools.partial": "partial",
            "typing.cast": "cast",
            "staticmethod": "staticmethod",
            "classmethod": "classmethod",
            "builtins.vars": "vars",
        }.get(dotted)

    def _unknown_project_callable(self, node: ast.AST, kind: str) -> str:
        scope = ".".join(self._scope_stack)
        prefix = f"{self._module_name}.{scope}." if scope else f"{self._module_name}."
        identity = f"{prefix}<unknown-{kind}>@{node.lineno}:{node.col_offset}"
        self._project_callables.add(identity)
        return identity

    def _resolve_callable_value(self, node: ast.AST | None) -> str | None:
        if node is None:
            return None
        if isinstance(node, ast.Lambda):
            return self._register_lambda(node)
        if isinstance(node, ast.NamedExpr):
            return self._resolve_callable_value(node.value)
        if isinstance(node, ast.IfExp):
            identities = [
                identity
                for identity in (
                    self._resolve_callable_value(node.body),
                    self._resolve_callable_value(node.orelse),
                )
                if identity is not None
            ]
            if len(identities) < 2:
                identities.append(self._unknown_project_callable(node, "conditional"))
            return self._merged_callable_identity(node, identities, "conditional")
        if isinstance(node, ast.BoolOp):
            identities = [
                identity
                for value in node.values
                if (identity := self._resolve_callable_value(value)) is not None
            ]
            if len(identities) < len(node.values):
                identities.append(self._unknown_project_callable(node, "boolean"))
            return self._merged_callable_identity(node, identities, "boolean")
        if (
            isinstance(node, ast.Subscript)
            and isinstance(node.value, ast.Attribute)
            and node.value.attr == "__dict__"
        ):
            module_path = _access_path(node.value.value)
            module = self._module_aliases.get(module_path) if module_path else None
            if module in self._project_modules:
                if isinstance(node.slice, ast.Constant) and isinstance(
                    node.slice.value, str
                ):
                    resolved = self._module_exports.get(module, {}).get(node.slice.value)
                    if resolved is not None:
                        return resolved
                return self._unknown_project_callable(node, "module-lookup")
            owner = self._callable_identity(node.value.value)
            if owner in self._class_identities:
                if isinstance(node.slice, ast.Constant) and isinstance(
                    node.slice.value, str
                ):
                    resolved = self._class_members.get((owner, node.slice.value))
                    if resolved is not None:
                        return resolved
                return self._unknown_project_callable(node, "class-lookup")
        if (
            isinstance(node, ast.Subscript)
            and isinstance(node.value, ast.Call)
            and self._callable_transform_kind(node.value.func) == "vars"
            and node.value.args
        ):
            owner_node = node.value.args[0]
            module_path = _access_path(owner_node)
            module = self._module_aliases.get(module_path) if module_path else None
            owner = self._callable_identity(owner_node)
            if isinstance(node.slice, ast.Constant) and isinstance(
                node.slice.value, str
            ):
                if module in self._project_modules:
                    resolved = self._module_exports.get(module, {}).get(node.slice.value)
                    if resolved is not None:
                        return resolved
                if owner in self._class_identities:
                    resolved = self._class_members.get((owner, node.slice.value))
                    if resolved is not None:
                        return resolved
            if module in self._project_modules or owner in self._class_identities:
                return self._unknown_project_callable(node, "vars-lookup")
        identity = self._callable_identity(node)
        if identity is not None:
            return identity
        if isinstance(node, ast.Call):
            transform = self._callable_transform_kind(node.func)
            if transform in {"classmethod", "partial", "staticmethod"} and node.args:
                return self._resolve_callable_value(node.args[0])
            if transform == "cast" and node.args:
                return self._resolve_callable_value(node.args[-1])
            if transform == "getattr" and len(node.args) >= 2:
                if isinstance(node.args[1], ast.Constant) and isinstance(
                    node.args[1].value, str
                ):
                    synthetic = ast.Attribute(
                        value=node.args[0], attr=node.args[1].value
                    )
                    resolved = self._callable_identity(synthetic)
                    if resolved is not None:
                        return resolved
                module_path = _access_path(node.args[0])
                module = self._module_aliases.get(module_path) if module_path else None
                if module in self._project_modules:
                    return self._unknown_project_callable(node, "getattr")
                owner = self._callable_identity(node.args[0])
                if owner in self._class_identities:
                    return self._unknown_project_callable(node, "getattr")
            called = self._callable_identity(node.func)
            if called is not None:
                if called in self.callable_returns:
                    target_identity, bound_receiver = self._call_target(node)
                    target_identity = target_identity or called
                    bindings = self._callable_bindings(
                        node, target_identity, bound_receiver
                    )
                    resolved_returns: list[str] = []
                    for returned in self.callable_returns[called]:
                        details = _parameter_details(returned)
                        if details is not None and details[0] == called:
                            if details[1] in bindings:
                                resolved_returns.append(bindings[details[1]])
                        else:
                            resolved_returns.append(returned)
                    return self._merged_callable_identity(
                        node, resolved_returns, "callable-return"
                    )
                if called in self._class_identities:
                    return called
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

    def _expression_is_demonstrably_safe(self, node: ast.AST | None) -> bool:
        if node is None or isinstance(node, ast.Constant):
            return True
        if isinstance(node, (ast.List, ast.Set, ast.Tuple)):
            return all(self._expression_is_demonstrably_safe(item) for item in node.elts)
        if isinstance(node, ast.Dict):
            return all(
                (key is None or self._expression_is_demonstrably_safe(key))
                and self._expression_is_demonstrably_safe(value)
                for key, value in zip(node.keys, node.values, strict=True)
            )
        if isinstance(node, ast.Lambda):
            identity = self._register_lambda(node)
            return identity in self.safe_functions
        if isinstance(node, ast.Call):
            identity = self._callable_identity(node.func)
            return identity is not None and identity in self.safe_functions
        return False

    def _expression_is_potentially_sensitive(self, node: ast.AST | None) -> bool:
        if self._expression_is_tainted(node):
            return True
        if isinstance(node, ast.Call):
            identity = self._resolve_callable_value(node.func)
            if (
                identity is not None
                and identity in self._project_callables
                and identity not in self.safe_functions
            ):
                return True
        return False

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
        if isinstance(node, (ast.GeneratorExp, ast.Lambda)):
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
            if (
                isinstance(node.func, ast.Name)
                and node.func.id in {"all", "any", "list", "set", "sorted", "sum", "tuple"}
                and (node.func.id,) not in self._bound_paths
            ):
                for value in node.args:
                    if isinstance(value, ast.GeneratorExp) and (
                        self._expression_is_tainted(value.elt)
                        or any(
                            self._expression_is_tainted(generator.iter)
                            or any(
                                self._expression_is_tainted(condition)
                                for condition in generator.ifs
                            )
                            for generator in value.generators
                        )
                    ):
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
        self._callable_transforms = {
            candidate: kind
            for candidate, kind in self._callable_transforms.items()
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
        self._bound_instances = {
            candidate
            for candidate in self._bound_instances
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
        if source is not None and source in self._bound_instances:
            self._bound_instances.add(target)
        callable_identity = self._resolve_callable_value(value)
        if callable_identity is not None:
            self._callable_aliases[target] = callable_identity
            if (
                isinstance(value, ast.Call)
                and callable_identity in self._class_identities
            ):
                self._bound_instances.add(target)
        transform_kind = self._callable_transform_kind(value)
        if transform_kind is not None:
            self._callable_transforms[target] = transform_kind
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

    def _bind_local_callable(self, name: str, identity: str | None = None) -> str:
        path = (name,)
        self._clear_target(path)
        self._bound_paths.add(path)
        self._callable_factories[path] = "local"
        resolved = identity or f"{self._module_name}.{name}@local"
        self._callable_aliases[path] = resolved
        self._project_callables.add(resolved)
        return resolved

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

    def _visit_function_scope(
        self,
        node: ast.FunctionDef | ast.AsyncFunctionDef,
        identity: str,
    ) -> None:
        positional = (*node.args.posonlyargs, *node.args.args)
        parameter_order = (*positional, *node.args.kwonlyargs)
        self.callable_parameters[identity] = tuple(
            argument.arg for argument in parameter_order
        )
        self.callable_variadics[identity] = (
            node.args.vararg.arg if node.args.vararg is not None else None,
            node.args.kwarg.arg if node.args.kwarg is not None else None,
        )
        defaults: dict[str, str] = {}
        positional_defaults = zip(
            positional[-len(node.args.defaults) :] if node.args.defaults else (),
            node.args.defaults,
            strict=True,
        )
        for argument, value in positional_defaults:
            callable_identity = self._resolve_callable_value(value)
            if callable_identity is not None:
                defaults[argument.arg] = callable_identity
        for argument, value in zip(
            node.args.kwonlyargs, node.args.kw_defaults, strict=True
        ):
            callable_identity = self._resolve_callable_value(value)
            if callable_identity is not None:
                defaults[argument.arg] = callable_identity
        self.callable_defaults[identity] = defaults
        previous_taint = self._tainted_paths
        previous_aliases = self._sink_aliases
        previous_request_paths = self._request_paths
        previous_receivers = self._durable_receivers
        previous_factories = self._callable_factories
        previous_callables = self._callable_aliases
        previous_transforms = self._callable_transforms
        previous_modules = self._module_aliases
        previous_bound_paths = self._bound_paths
        previous_bound_instances = self._bound_instances
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
        self._callable_transforms = dict(previous_transforms)
        self._module_aliases = dict(previous_modules)
        self._bound_paths = set(previous_bound_paths)
        self._bound_instances = set(previous_bound_instances)
        self._flask_module_aliases = set(previous_flask_aliases)
        self._path_constructor_aliases = set(previous_path_aliases)
        for name in parameter_names:
            path = (name,)
            self._clear_target(path)
            self._bound_paths.add(path)
            token = _parameter_identity(identity, name)
            self._callable_aliases[path] = token
            if name == "request":
                self._request_paths.add(path)
        if node.args.vararg is not None:
            self._callable_aliases[
                (node.args.vararg.arg, WILDCARD_SUBSCRIPT_COMPONENT)
            ] = _parameter_identity(identity, node.args.vararg.arg)
        if node.args.kwarg is not None:
            self._callable_aliases[
                (node.args.kwarg.arg, WILDCARD_SUBSCRIPT_COMPONENT)
            ] = _parameter_identity(identity, node.args.kwarg.arg)
        self._tainted_paths.update(
            (name,) for name in parameter_names if SENSITIVE_NAME_PATTERN.search(name)
        )
        self._function_stack.append(identity)
        self._parameter_stack.append(parameter_names)
        self._function_return_states[identity] = set()
        self._scope_stack.append(f"{node.name}@{node.lineno}")
        for statement in node.body:
            self.visit(statement)
        self._scope_stack.pop()
        self._parameter_stack.pop()
        self._function_stack.pop()
        states = self._function_return_states[identity]
        if not states or states <= {"safe", "callable"}:
            self.safe_functions.add(identity)
        self._tainted_paths = previous_taint
        self._sink_aliases = previous_aliases
        self._request_paths = previous_request_paths
        self._durable_receivers = previous_receivers
        self._callable_factories = previous_factories
        self._callable_aliases = previous_callables
        self._callable_transforms = previous_transforms
        self._module_aliases = previous_modules
        self._bound_paths = previous_bound_paths
        self._bound_instances = previous_bound_instances
        self._flask_module_aliases = previous_flask_aliases
        self._path_constructor_aliases = previous_path_aliases

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        identity = self._bind_local_callable(
            node.name,
            self._node_identities.get(id(node)),
        )
        self._visit_function_scope(node, identity)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        identity = self._bind_local_callable(
            node.name,
            self._node_identities.get(id(node)),
        )
        self._visit_function_scope(node, identity)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        for expression in (*node.decorator_list, *node.bases):
            self.visit(expression)
        for keyword in node.keywords:
            self.visit(keyword.value)
        identity = self._bind_local_callable(
            node.name,
            self._node_identities.get(id(node)),
        )
        previous_taint = self._tainted_paths
        previous_aliases = self._sink_aliases
        previous_request_paths = self._request_paths
        previous_receivers = self._durable_receivers
        previous_factories = self._callable_factories
        previous_callables = self._callable_aliases
        previous_transforms = self._callable_transforms
        previous_modules = self._module_aliases
        previous_bound_paths = self._bound_paths
        previous_bound_instances = self._bound_instances
        previous_flask_aliases = self._flask_module_aliases
        previous_path_aliases = self._path_constructor_aliases
        self._tainted_paths = set(previous_taint)
        self._sink_aliases = dict(previous_aliases)
        self._request_paths = set(previous_request_paths)
        self._durable_receivers = dict(previous_receivers)
        self._callable_factories = dict(previous_factories)
        self._callable_aliases = dict(previous_callables)
        self._callable_transforms = dict(previous_transforms)
        self._module_aliases = dict(previous_modules)
        self._bound_paths = set(previous_bound_paths)
        self._bound_instances = set(previous_bound_instances)
        self._flask_module_aliases = set(previous_flask_aliases)
        self._path_constructor_aliases = set(previous_path_aliases)
        self._scope_stack.append(f"{node.name}@{node.lineno}")
        for statement in node.body:
            self.visit(statement)
        self._scope_stack.pop()
        self._tainted_paths = previous_taint
        self._sink_aliases = previous_aliases
        self._request_paths = previous_request_paths
        self._durable_receivers = previous_receivers
        self._callable_factories = previous_factories
        self._callable_aliases = previous_callables
        self._callable_transforms = previous_transforms
        self._module_aliases = previous_modules
        self._bound_paths = previous_bound_paths
        self._bound_instances = previous_bound_instances
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
        if self._function_stack:
            identity = self._function_stack[-1]
            states = self._function_return_states[identity]
            if self._expression_is_request_object(node.value):
                self.request_functions.add(identity)
                states.add("request")
            if self._expression_is_tainted(node.value):
                self.tainted_functions.add(identity)
                states.add("tainted")
            callable_identity = self._resolve_callable_value(node.value)
            if callable_identity is not None:
                self.callable_returns.setdefault(identity, set()).add(
                    callable_identity
                )
                states.add("callable")
            elif self._expression_is_demonstrably_safe(node.value):
                states.add("safe")
            else:
                states.add("unknown")
        if node.value is not None:
            self.visit(node.value)

    def visit_Import(self, node: ast.Import) -> None:
        tracked_modules = {"builtins", "functools", "io", "shelve", "sys", "typing"}
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
                for name, identity in self._module_exports.get(
                    imported_module, {}
                ).items():
                    if not name.startswith("_"):
                        target = self._bind_import(name)
                        self._callable_aliases[target] = identity
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
            if node.module == "typing" and alias.name == "cast":
                self._callable_transforms[target] = "cast"
            elif node.module == "functools" and alias.name == "partial":
                self._callable_transforms[target] = "partial"
            elif node.module == "builtins" and alias.name == "getattr":
                self._callable_transforms[target] = "getattr"
            imported_identity = self._module_exports.get(imported_module, {}).get(
                alias.name
            )
            if imported_identity is not None:
                self._callable_aliases[target] = imported_identity

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

    def visit_Lambda(self, node: ast.Lambda) -> None:
        self._register_lambda(node)

    def visit_GeneratorExp(self, node: ast.GeneratorExp) -> None:
        # Generator bodies do not execute merely because the generator is created.
        return

    def _record_parameter_sink_calls(
        self, value: ast.AST, sink_kind: str
    ) -> None:
        if not self._function_stack or not self._parameter_stack:
            return
        identity = self._function_stack[-1]
        for candidate in ast.walk(value):
            if not isinstance(candidate, ast.Call):
                continue
            callable_identity = self._resolve_callable_value(candidate.func)
            details = (
                _parameter_details(callable_identity)
                if callable_identity is not None
                else None
            )
            if details is not None and details[0] == identity:
                parameter_sinks = self.callable_parameter_sinks.setdefault(
                    identity, {}
                )
                parameter_sinks.setdefault(details[1], set()).add(sink_kind)

    def _call_target(self, node: ast.Call) -> tuple[str | None, bool]:
        identity = self._callable_identity(node.func)
        if identity is None:
            return None, False
        func_path = _access_path(node.func)
        if identity in self._class_identities:
            instance_call = func_path is not None and func_path in self._bound_instances
            member_name = "__call__" if instance_call else "__init__"
            return self._class_members.get((identity, member_name)), True
        if isinstance(node.func, ast.Attribute):
            binding = self._class_member_bindings.get(identity, "instance")
            receiver_path = _access_path(node.func.value)
            receiver_is_instance = (
                receiver_path is not None and receiver_path in self._bound_instances
            )
            return identity, binding == "class" or (
                binding == "instance" and receiver_is_instance
            )
        return identity, False

    def _expanded_call_values(
        self, node: ast.Call
    ) -> tuple[list[ast.AST], dict[str, ast.AST], bool, bool]:
        positional: list[ast.AST] = []
        unknown_star = False
        for value in node.args:
            if isinstance(value, ast.Starred):
                if isinstance(value.value, (ast.List, ast.Tuple)):
                    positional.extend(value.value.elts)
                else:
                    unknown_star = True
            else:
                positional.append(value)
        keywords: dict[str, ast.AST] = {}
        unknown_kwargs = False
        for keyword in node.keywords:
            if keyword.arg is not None:
                keywords[keyword.arg] = keyword.value
            elif isinstance(keyword.value, ast.Dict):
                for key, value in zip(
                    keyword.value.keys, keyword.value.values, strict=True
                ):
                    if isinstance(key, ast.Constant) and isinstance(key.value, str):
                        keywords[key.value] = value
                    else:
                        unknown_kwargs = True
            else:
                unknown_kwargs = True
        return positional, keywords, unknown_star, unknown_kwargs

    def _container_callable_identities(self, node: ast.AST) -> list[str]:
        if isinstance(node, (ast.List, ast.Set, ast.Tuple)):
            return [
                resolved
                for value in node.elts
                if (resolved := self._resolve_callable_value(value)) is not None
            ]
        if isinstance(node, ast.Dict):
            return [
                resolved
                for value in node.values
                if (resolved := self._resolve_callable_value(value)) is not None
            ]
        path = _access_path(node)
        if path is None:
            return []
        return [
            identity
            for candidate, identity in self._callable_aliases.items()
            if _path_is_prefix(path, candidate) and len(candidate) > len(path)
        ]

    def _callable_bindings(
        self, node: ast.Call, identity: str, bound_receiver: bool
    ) -> dict[str, str]:
        parameters = list(self.callable_parameters.get(identity, ()))
        if bound_receiver and parameters:
            parameters = parameters[1:]
        positional, keywords, unknown_star, unknown_kwargs = (
            self._expanded_call_values(node)
        )
        starred_identities: list[str] = []
        for value in node.args:
            if isinstance(value, ast.Starred) and not isinstance(
                value.value, (ast.List, ast.Tuple)
            ):
                starred_identities.extend(
                    self._container_callable_identities(value.value)
                )
        if unknown_star and not starred_identities:
            starred_identities.append(
                self._unknown_project_callable(node, "star-args")
            )
        starred_binding = self._merged_callable_identity(
            node, starred_identities, "star-args"
        )
        bindings: dict[str, str] = {}
        consumed_names: set[str] = set()
        for name, value in zip(parameters, positional):
            consumed_names.add(name)
            if (resolved := self._resolve_callable_value(value)) is not None:
                bindings[name] = resolved
        for name, value in keywords.items():
            if name in parameters:
                consumed_names.add(name)
                if (resolved := self._resolve_callable_value(value)) is not None:
                    bindings[name] = resolved
        for name, default in self.callable_defaults.get(identity, {}).items():
            if name not in consumed_names:
                bindings[name] = default
        if starred_binding is not None:
            for name in parameters:
                if name not in consumed_names and name not in bindings:
                    bindings[name] = starred_binding
        vararg, kwarg = self.callable_variadics.get(identity, (None, None))
        remaining = positional[len(parameters) :]
        if vararg is not None:
            identities = [
                resolved
                for value in remaining
                if (resolved := self._resolve_callable_value(value)) is not None
            ]
            identities.extend(starred_identities)
            merged = self._merged_callable_identity(node, identities, "star-args")
            if merged is not None:
                bindings[vararg] = merged
        if kwarg is not None:
            extra_keywords = {
                name: value for name, value in keywords.items() if name not in parameters
            }
            identities = [
                resolved
                for value in extra_keywords.values()
                if (resolved := self._resolve_callable_value(value)) is not None
            ]
            expanded_kwargs: list[str] = []
            for keyword in node.keywords:
                if keyword.arg is None and not isinstance(keyword.value, ast.Dict):
                    expanded_kwargs.extend(
                        self._container_callable_identities(keyword.value)
                    )
            if unknown_kwargs and not expanded_kwargs:
                expanded_kwargs.append(
                    self._unknown_project_callable(node, "star-kwargs")
                )
            identities.extend(expanded_kwargs)
            merged = self._merged_callable_identity(node, identities, "star-kwargs")
            if merged is not None:
                bindings[kwarg] = merged
            if merged is not None:
                for name in parameters:
                    if name not in consumed_names and name not in bindings:
                        bindings[name] = merged
        return bindings

    def _check_parameterized_call(self, node: ast.Call) -> None:
        identity, bound_receiver = self._call_target(node)
        parameter_sinks = (
            self.callable_parameter_sinks.get(identity, {})
            if identity is not None
            else {}
        )
        if not parameter_sinks or identity is None:
            return
        bindings = self._callable_bindings(node, identity, bound_receiver)
        for name, sink_kinds in parameter_sinks.items():
            callable_identity = bindings.get(name)
            details = (
                _parameter_details(callable_identity)
                if callable_identity is not None
                else None
            )
            if details is not None and self._function_stack:
                owner, parameter = details
                if owner == self._function_stack[-1]:
                    parameter_summaries = self.callable_parameter_sinks.setdefault(
                        owner, {}
                    )
                    parameter_summaries.setdefault(parameter, set()).update(sink_kinds)
                continue
            if (
                callable_identity is not None
                and callable_identity in self._project_callables
                and callable_identity not in self.safe_functions
            ):
                self.findings.update(sink_kinds)

    def visit_Call(self, node: ast.Call) -> None:
        if isinstance(node.func, ast.Lambda):
            self.visit(node.func.body)
        if (
            isinstance(node.func, ast.Name)
            and node.func.id in {"all", "any", "list", "set", "sorted", "sum", "tuple"}
            and (node.func.id,) not in self._bound_paths
        ):
            for value in node.args:
                if isinstance(value, ast.GeneratorExp):
                    self.visit(value.elt)
                    for generator in value.generators:
                        self.visit(generator.iter)
                        for condition in generator.ifs:
                            self.visit(condition)
        self._check_parameterized_call(node)
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
        has_potentially_sensitive_value = any(
            self._expression_is_potentially_sensitive(value) for value in values
        )
        if sink_kind is not None and has_potentially_sensitive_value:
            self.findings.add(sink_kind)
        if sink_kind is not None:
            for value in values:
                self._record_parameter_sink_calls(value, sink_kind)
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


def _resolve_import_module(
    current_module: str,
    imported_module: str | None,
    level: int,
) -> str:
    if level == 0:
        return imported_module or ""
    package = current_module.split(".")[:-1]
    ascend = max(level - 1, 0)
    if ascend:
        package = package[:-ascend]
    if imported_module:
        package.extend(imported_module.split("."))
    return ".".join(package)


def _definition_catalog(
    parsed_modules: dict[str, ast.Module],
    modules_by_path: dict[str, str],
) -> tuple[
    dict[str, dict[str, str]],
    dict[str, str],
    dict[tuple[str, str], str],
    set[str],
    set[str],
    dict[str, dict[int, str]],
    dict[str, str],
]:
    exports: dict[str, dict[str, str]] = {
        module: {} for module in modules_by_path.values()
    }
    public_callables: dict[str, str] = {}
    class_members: dict[tuple[str, str], str] = {}
    class_identities: set[str] = set()
    project_callables: set[str] = set()
    identities_by_path: dict[str, dict[int, str]] = {
        path: {} for path in parsed_modules
    }
    class_member_bindings: dict[str, str] = {}

    class_bases: list[tuple[str, str, tuple[ast.expr, ...]]] = []
    class_assignments: list[tuple[str, str, ast.Assign | ast.AnnAssign]] = []
    project_module_aliases: dict[str, dict[str, str]] = {
        module: {} for module in modules_by_path.values()
    }
    for relative_path, parsed in parsed_modules.items():
        module = modules_by_path[relative_path]
        for statement in parsed.body:
            if isinstance(statement, ast.Import):
                for alias in statement.names:
                    if alias.name in exports:
                        project_module_aliases[module][
                            alias.asname or alias.name.split(".", 1)[0]
                        ] = (
                            alias.name
                            if alias.asname
                            else alias.name.split(".", 1)[0]
                        )

    def register_lambda(
        relative_path: str, node: ast.Lambda, scope: tuple[str, ...]
    ) -> str:
        module = modules_by_path[relative_path]
        prefix = ".".join((module, *scope))
        identity = f"{prefix + '.' if prefix else ''}<lambda>@{node.lineno}:{node.col_offset}"
        identities_by_path[relative_path][id(node)] = identity
        project_callables.add(identity)
        return identity

    def assigned_lambda(node: ast.AST | None) -> ast.Lambda | None:
        if isinstance(node, ast.Lambda):
            return node
        if (
            isinstance(node, ast.Call)
            and _dotted_name(node.func) in {"classmethod", "staticmethod"}
            and node.args
            and isinstance(node.args[0], ast.Lambda)
        ):
            return node.args[0]
        return None

    def binding_kind(node: ast.AST | None) -> str:
        if isinstance(node, ast.Call):
            if _dotted_name(node.func) == "staticmethod":
                return "static"
            if _dotted_name(node.func) == "classmethod":
                return "class"
        return "instance"

    def register(
        relative_path: str,
        node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef,
        scope: tuple[str, ...],
    ) -> str:
        module = modules_by_path[relative_path]
        qualified_part = f"{node.name}@{node.lineno}"
        identity = ".".join((module, *scope, qualified_part))
        identities_by_path[relative_path][id(node)] = identity
        project_callables.add(identity)
        child_scope = (*scope, qualified_part)
        if isinstance(node, ast.ClassDef):
            class_identities.add(identity)
            class_bases.append((identity, module, tuple(node.bases)))
        for child in node.body:
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                child_identity = register(relative_path, child, child_scope)
                if isinstance(node, ast.ClassDef):
                    class_members[(identity, child.name)] = child_identity
                    decorators = {
                        _dotted_name(decorator) for decorator in child.decorator_list
                    }
                    class_member_bindings[child_identity] = (
                        "static"
                        if "staticmethod" in decorators
                        else "class" if "classmethod" in decorators else "instance"
                    )
            elif isinstance(child, (ast.Assign, ast.AnnAssign)):
                if isinstance(node, ast.ClassDef):
                    class_assignments.append((identity, module, child))
                value = assigned_lambda(child.value)
                if value is None:
                    continue
                lambda_identity = register_lambda(relative_path, value, child_scope)
                targets = child.targets if isinstance(child, ast.Assign) else [child.target]
                for target in targets:
                    if isinstance(target, ast.Name) and isinstance(node, ast.ClassDef):
                        class_members[(identity, target.id)] = lambda_identity
                        class_member_bindings[lambda_identity] = binding_kind(
                            child.value
                        )
        return identity

    for relative_path, parsed in parsed_modules.items():
        module = modules_by_path[relative_path]
        for node in parsed.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                identity = register(relative_path, node, ())
                exports[module][node.name] = identity
                public_callables[f"{module}.{node.name}"] = identity
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                value = assigned_lambda(node.value)
                if value is None:
                    continue
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    if isinstance(target, ast.Name):
                        identity = register_lambda(relative_path, value, ())
                        exports[module][target.id] = identity
                        public_callables[f"{module}.{target.id}"] = identity

    def resolve_catalog_value(
        module: str,
        value: ast.AST,
        module_aliases: dict[str, str],
    ) -> str | None:
        if isinstance(value, ast.Name):
            return exports[module].get(value.id)
        if isinstance(value, ast.Attribute):
            dotted = _dotted_name(value)
            if dotted is None:
                return None
            components = dotted.split(".")
            source_root = module_aliases.get(components[0])
            if source_root is None:
                owner = exports[module].get(components[0])
                if owner is not None and len(components) == 2:
                    return class_members.get((owner, components[1]))
                return None
            full = ".".join((source_root, *components[1:]))
            for source_module in sorted(exports, key=len, reverse=True):
                prefix = f"{source_module}."
                if full.startswith(prefix) and "." not in full.removeprefix(prefix):
                    return exports[source_module].get(full.removeprefix(prefix))
        return None

    def resolve_assignment_bindings(
        module: str,
        target: ast.AST,
        value: ast.AST,
        module_aliases: dict[str, str],
    ) -> dict[str, str]:
        if (
            isinstance(target, (ast.List, ast.Tuple))
            and isinstance(value, (ast.List, ast.Tuple))
            and len(target.elts) == len(value.elts)
        ):
            resolved: dict[str, str] = {}
            for destination, item in zip(target.elts, value.elts, strict=True):
                resolved.update(
                    resolve_assignment_bindings(
                        module, destination, item, module_aliases
                    )
                )
            return resolved
        identity = resolve_catalog_value(module, value, module_aliases)
        return {target.id: identity} if isinstance(target, ast.Name) and identity else {}

    for _ in range(len(parsed_modules) + len(class_identities) + 2):
        changed = False
        for relative_path, parsed in parsed_modules.items():
            module = modules_by_path[relative_path]
            module_aliases: dict[str, str] = {}
            for node in parsed.body:
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        if alias.name in exports:
                            module_aliases[
                                alias.asname or alias.name.split(".", 1)[0]
                            ] = (
                                alias.name
                                if alias.asname
                                else alias.name.split(".", 1)[0]
                            )
                    continue
                imported: dict[str, str] = {}
                if isinstance(node, ast.ImportFrom):
                    source_module = _resolve_import_module(
                        module,
                        node.module,
                        node.level,
                    )
                    source_exports = exports.get(source_module, {})
                    for alias in node.names:
                        if alias.name == "*":
                            imported.update(
                                {
                                    name: identity
                                    for name, identity in source_exports.items()
                                    if not name.startswith("_")
                                }
                            )
                        elif (identity := source_exports.get(alias.name)) is not None:
                            imported[alias.asname or alias.name] = identity
                elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                    value = node.value
                    targets = (
                        node.targets if isinstance(node, ast.Assign) else [node.target]
                    )
                    for target in targets:
                        imported.update(
                            resolve_assignment_bindings(
                                module, target, value, module_aliases
                            )
                        )
                for name, identity in imported.items():
                    if exports[module].get(name) != identity:
                        exports[module][name] = identity
                        public_callables[f"{module}.{name}"] = identity
                        changed = True

        for class_identity, module, assignment in class_assignments:
            value = assignment.value
            if (
                isinstance(value, ast.Call)
                and binding_kind(value) in {"class", "static"}
                and value.args
            ):
                value = value.args[0]
            member_identity = resolve_catalog_value(
                module, value, project_module_aliases[module]
            )
            if member_identity is None:
                continue
            targets = (
                assignment.targets
                if isinstance(assignment, ast.Assign)
                else [assignment.target]
            )
            for target in targets:
                if not isinstance(target, ast.Name):
                    continue
                key = (class_identity, target.id)
                if class_members.get(key) != member_identity:
                    class_members[key] = member_identity
                    class_member_bindings[member_identity] = binding_kind(
                        assignment.value
                    )
                    changed = True

        for class_identity, module, bases in class_bases:
            for base in bases:
                base_identity = resolve_catalog_value(
                    module, base, project_module_aliases[module]
                )
                if base_identity is None:
                    continue
                for (owner, name), member_identity in tuple(class_members.items()):
                    if owner != base_identity:
                        continue
                    key = (class_identity, name)
                    if key not in class_members:
                        class_members[key] = member_identity
                        changed = True
        if not changed:
            break

    return (
        exports,
        public_callables,
        class_members,
        class_identities,
        project_callables,
        identities_by_path,
        class_member_bindings,
    )


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
    (
        module_exports,
        public_callables,
        class_members,
        class_identities,
        project_callables,
        identities_by_path,
        class_member_bindings,
    ) = _definition_catalog(parsed_modules, modules_by_path)
    tainted_functions: set[str] = set()
    request_functions: set[str] = set()
    safe_functions: set[str] = set()
    callable_returns: dict[str, set[str]] = {}
    callable_parameter_sinks: dict[str, dict[str, set[str]]] = {}
    callable_parameters: dict[str, tuple[str, ...]] = {}
    callable_defaults: dict[str, dict[str, str]] = {}
    callable_variadics: dict[str, tuple[str | None, str | None]] = {}
    function_count = sum(
        isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        for parsed in parsed_modules.values()
        for node in ast.walk(parsed)
    )
    iteration_findings = {relative_path: set() for relative_path in contents}
    for _ in range(function_count + len(project_callables) + 2):
        discovered_tainted = set(tainted_functions)
        discovered_request = set(request_functions)
        discovered_safe = set(safe_functions)
        discovered_callable_returns = {
            identity: set(returns)
            for identity, returns in callable_returns.items()
        }
        discovered_parameter_sinks = {
            identity: {name: set(kinds) for name, kinds in parameters.items()}
            for identity, parameters in callable_parameter_sinks.items()
        }
        discovered_parameters = dict(callable_parameters)
        discovered_defaults = {
            identity: dict(defaults)
            for identity, defaults in callable_defaults.items()
        }
        discovered_variadics = dict(callable_variadics)
        iteration_findings = {relative_path: set() for relative_path in contents}
        for relative_path, parsed in parsed_modules.items():
            module_name = modules_by_path[relative_path]
            visitor = PythonRetentionVisitor(
                tainted_functions,
                request_functions,
                safe_functions,
                callable_returns,
                module_name=module_name,
                project_modules=project_modules,
                project_callables=project_callables,
                initial_callables=module_exports.get(module_name, {}),
                public_callables=public_callables,
                class_members=class_members,
                class_identities=class_identities,
                node_identities=identities_by_path.get(relative_path, {}),
                module_exports=module_exports,
                callable_parameter_sinks=callable_parameter_sinks,
                callable_parameters=callable_parameters,
                callable_defaults=callable_defaults,
                callable_variadics=callable_variadics,
                class_member_bindings=class_member_bindings,
            )
            visitor.visit(parsed)
            iteration_findings[relative_path].update(visitor.findings)
            discovered_tainted.update(visitor.tainted_functions)
            discovered_request.update(visitor.request_functions)
            discovered_safe.update(visitor.safe_functions)
            for identity, returns in visitor.callable_returns.items():
                discovered_callable_returns.setdefault(identity, set()).update(returns)
            for identity, parameters in visitor.callable_parameter_sinks.items():
                target_parameters = discovered_parameter_sinks.setdefault(identity, {})
                for name, kinds in parameters.items():
                    target_parameters.setdefault(name, set()).update(kinds)
            discovered_parameters.update(visitor.callable_parameters)
            discovered_defaults.update(visitor.callable_defaults)
            discovered_variadics.update(visitor.callable_variadics)
            project_callables.update(visitor._project_callables)
        if (
            discovered_tainted == tainted_functions
            and discovered_request == request_functions
            and discovered_safe == safe_functions
            and discovered_callable_returns == callable_returns
            and discovered_parameter_sinks == callable_parameter_sinks
            and discovered_parameters == callable_parameters
            and discovered_defaults == callable_defaults
            and discovered_variadics == callable_variadics
        ):
            for relative_path, rules in iteration_findings.items():
                findings[relative_path].update(rules)
            break
        tainted_functions = discovered_tainted
        request_functions = discovered_request
        safe_functions = discovered_safe
        callable_returns = discovered_callable_returns
        callable_parameter_sinks = discovered_parameter_sinks
        callable_parameters = discovered_parameters
        callable_defaults = discovered_defaults
        callable_variadics = discovered_variadics
    else:
        for relative_path, rules in iteration_findings.items():
            findings[relative_path].update(rules)
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
            if rule_name == "request-content-log" and relative_path.endswith(".py"):
                # The Python analyzer distinguishes executed content from deferred
                # lambda and generator bodies; the line regex cannot do so safely.
                continue
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
