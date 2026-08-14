#!/usr/bin/env python3
"""Fail-closed retention architecture checks using the CPython 3.12 AST schema."""

from __future__ import annotations

import argparse
import ast
from collections import Counter
from dataclasses import dataclass
import hashlib
import os
import re
import stat
import subprocess
import sys
from pathlib import Path


PRODUCTION_PREFIXES = ("server/", "static/", "contracts/")
PRODUCTION_FILES = {"app.py", "render.yaml", "Procfile"}
SENSITIVE_FIELDS = r"(?:resume_text|job_description|filename|pdf_base64)"

ARTIFACT_MAX_BYTES = 32 * 1024 * 1024
ARTIFACT_RULES = (
    (
        "sensitive-field-name",
        re.compile(
            r"(?i)(?:resume_text|job_description|pdf_base64|installation_id|account_id|account_token|installation_token)"
        ),
    ),
    ("fixture-marker", re.compile(r"PRIVATE_MARKER_[A-Za-z0-9_-]+")),
    (
        "absolute-path",
        re.compile(r"(?:/Users/|/home/|/var/folders/|[A-Za-z]:\\Users\\)"),
    ),
    (
        "token-shape",
        re.compile(
            r"(?:signed-installation-token|rai_(?:installation|account)_[A-Za-z0-9_-]{16,}|(?:inst|acct)_[A-Za-z0-9_-]{16,})"
        ),
    ),
)

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
    {"dbm", "psycopg", "psycopg2", "redis", "shelve", "sqlalchemy", "sqlite3"}
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
        "os.creat",
        "shutil.copy",
        "shutil.copy2",
        "shutil.copyfile",
        "shutil.copyfileobj",
        "shutil.copymode",
        "shutil.copystat",
        "shutil.copytree",
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
        "runpy.run_module",
        "runpy.run_path",
    }
)
LOGGING_CANONICAL_CAPABILITIES = frozenset(
    {
        "builtins.print",
        "warnings.showwarning",
        "warnings.warn",
        "warnings.warn_explicit",
    }
)
DYNAMIC_MODULE_ROOTS = frozenset({"importlib", "runpy"})
BUILTIN_CALLABLE_KINDS = {
    "__import__": "dynamic",
    "compile": "dynamic",
    "eval": "dynamic",
    "exec": "dynamic",
    "getattr": "getattr",
    "globals": "dynamic",
    "locals": "dynamic",
    "open": "open",
    "print": "logging",
    "vars": "vars",
}
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
class SecurityScopeAttestation:
    fingerprint: str
    count: int


@dataclass(frozen=True)
class TrustedBoundary:
    module_fingerprint: str
    approved_capabilities: tuple[CapabilityAttestation, ...]
    approved_security_scopes: tuple[SecurityScopeAttestation, ...]


TRUSTED_BOUNDARIES: dict[str, TrustedBoundary] = {
    "server/entitlements.py": TrustedBoundary(
        module_fingerprint=(
            "ec17ce0cfa0ca17ca9451d6d46510d893f46883d606694be4daf95fe890f8ee5"
        ),
        approved_capabilities=(
            CapabilityAttestation("durable", "0f18ee8fdcb6967b6fd77238872d58c46ecfffaef3e2db41d0812bc21fb94ed3", 12),
            CapabilityAttestation("durable", "4e7660224a10225d5d36de126bf8627b22ab45310bfb9ce4879c7b7f849d84bb", 5),
            CapabilityAttestation("durable", "53ae361092cafa3b79d326d48440765d5abee76871ec43189346d97e6a728180", 9),
            CapabilityAttestation("durable", "72272d7c74c706820eac7eba0bd0e1abc76415e2e70bc156c2bfb72e032a48ba", 2),
            CapabilityAttestation("durable", "75783dc68a2064d137e3377c77abd2e4e5b9ec74465b7e791684970e0a6a5135", 9),
            CapabilityAttestation("durable", "8d09c801930ddfeeb739fe7de53d4b392ff9713440ecd55107d31b29f3432a11", 1),
            CapabilityAttestation("durable", "b6909f6bcf1012f4b5402a529fa794d5315d14ffbe28566ce5ac9f6821d725dd", 1),
            CapabilityAttestation("durable", "fc0d32cb7a9f7cafd46a84dd71e5763fc6eadc3d2feebb5c384ff4d7c7b56b7d", 9),
            CapabilityAttestation("durable", "fc9abcc37947c1001384dd124606ca635ca0def725383e4be88be8d287917628", 7),
        ),
        approved_security_scopes=(
            SecurityScopeAttestation("0058541dace4eef391fa3c5c547c0776ca1c9768b46801697e7d9e9070f4672a", 1),
            SecurityScopeAttestation("047eff597e9573afa2a658fd212dcdc2d66f3020df703988c6a8f90935b7fef8", 1),
            SecurityScopeAttestation("056ff751f1ed3c108880197a022860feb7f2bcb4bde51f2aabe594486d722723", 1),
            SecurityScopeAttestation("060fcfc9cc821514913c056fce2d83bda074b1af2b2f182b909474864b8270bb", 1),
            SecurityScopeAttestation("08da1a0da62fca5bf7bbd85dbc8fe155dc4af07af04a2e975cc02293b61ccc7c", 1),
            SecurityScopeAttestation("0ad62d2419386a70f453b428a256987cb292ef7105cfee62781a0039ac4e540b", 3),
            SecurityScopeAttestation("13a5a9ea505f36397ba312222d32804e8e1350e489ebf754870fdb647e1b362b", 1),
            SecurityScopeAttestation("184d91da1e9c08d8b6d27c29be363a4921ad45e3b243742f3da1c79e151f405e", 1),
            SecurityScopeAttestation("1857a3d081440162ee55fcef3ae5b664a51bd9ebdae77890a4f5570f033c08c1", 1),
            SecurityScopeAttestation("1c6fc7ca6398f4daa7925ddd589e38426ab2f0f8ac4408ef840c9cb2e549cd9d", 1),
            SecurityScopeAttestation("1dc06475004784a1f2cc239da4bf370f14af31b0f40f00aa78acf5a5eacac9fa", 1),
            SecurityScopeAttestation("26dac73929e62b80f694820b3bc94f724558510cdbaf15b1205c039c7c032807", 1),
            SecurityScopeAttestation("1f794bce1c903aeb760ece69e7d2d073094b50dd77cf0b7e2a3872bcca05ee95", 1),
            SecurityScopeAttestation("21508cfb88f6f57cf5b43a76a785434108eb85473108d81113dd1c69159f0b1d", 1),
            SecurityScopeAttestation("2344fa10087e30d9aee5bc8715fea8b9efdd6021c74797291c445b923b7b453d", 1),
            SecurityScopeAttestation("271a5b0b4adc01056951cf0aed0ce9e630029ffe1787ea5e0563ad1341c865d4", 1),
            SecurityScopeAttestation("2e869aae0e0c8b6145d1b4d3d483ff170ce87e069846d717653624d54b969394", 1),
            SecurityScopeAttestation("2fc196a3e6f6a54f4b4e8a7d9d6849c931aeaad40a93879b41b7585545eaa6b1", 1),
            SecurityScopeAttestation("311781e89b8ae2031808bcbe9233ab49403c9c09e1dc69d5f064e57218d9b903", 3),
            SecurityScopeAttestation("3a3c14e5aed5fcbdf386d19bda8275fb1453a09e2d844c87aa84654ee195c296", 1),
            SecurityScopeAttestation("95b87392f9f2a28253027f7d3bcafe7b2f4f3e71eeba48e9f2da193bb11e6be7", 1),
            SecurityScopeAttestation("3be5d3b1084eaf5ac3e31ec5a248e3524e890737cabc06f4c79b33fafe558040", 1),
            SecurityScopeAttestation("3c23efa8c78d3d025387a82aefaea598ecfea268bd82ce9d10d3d479d1580ed1", 1),
            SecurityScopeAttestation("3eb3bdd73f49afb9900e430024eb1e54b8a7c60688e5161c90d33469e6143049", 1),
            SecurityScopeAttestation("41205fd450d92847501aca22578b3400f743494af25624ff4b0e279ccc729d75", 1),
            SecurityScopeAttestation("41313d1bb7f8a7e9772cee346498d3d2f924f1f3507527090987157da08639e6", 1),
            SecurityScopeAttestation("42629073a84b4b76ba313af0d3e305400d0aa773650accbfb812dca3fd36571b", 1),
            SecurityScopeAttestation("46eaa3e31a22b0cfdc25e0a0f58eab1efb1ccb61eb3395e0eb3347db10b0fc41", 1),
            SecurityScopeAttestation("4eec2f480508bc9f5d16525c59e26d20bee251815d1afa32c8ab22a15fc1117d", 1),
            SecurityScopeAttestation("501b2a170534ee6043beff92b034172aaaa64a6f83c83ac72a8d7ebdc971f379", 1),
            SecurityScopeAttestation("50e1d3da3a1827491d81c235ed391bcd897a5f19224958e54ec1f2c219b3bd9b", 1),
            SecurityScopeAttestation("50ee41fccd7a499251dc06f9f39cdd4ecd22b2b4c620bf747914f5451bdf009a", 1),
            SecurityScopeAttestation("5f893296fb212a3050ab195ade943a6184bd75dddd908cc5840ab56797de4d81", 1),
            SecurityScopeAttestation("62ecdf575b2cdd22c6f2d6e590ef5bbc10357af18840ad0ddd7f3047a00f0df7", 1),
            SecurityScopeAttestation("654dde0d762e23bc76831fd63942c91d3d6137ca155296f082aae25692114faa", 1),
            SecurityScopeAttestation("eb764caabc38cbef2e09d7c0724e351cfab33a917cb8545bece1ba5c8affe4ad", 1),
            SecurityScopeAttestation("6eb76b94c2997dea21646277ab514238f4ed9dbe0763a271eea557dbefa01ae0", 1),
            SecurityScopeAttestation("711514eef4b125a1bca1c542f809f8b31c18f7a0fe2360fd620b6f87e1e2dbfe", 1),
            SecurityScopeAttestation("72a02acdd04a8b556d1530afd71153c11c014933c2a64022ff568050cfcec561", 1),
            SecurityScopeAttestation("789549cc67097a835dc3678a9f74a4f578e7e74f28c91d00461990fdf95d08e1", 1),
            SecurityScopeAttestation("7b4c486e9b36f2b94d6045cb2e8fe1ef0c44784ea7ae99b4f5d92fc89e659d49", 1),
            SecurityScopeAttestation("b6c1dfaebf32f93bd606f279484ea1929da58b1eaf609997cedd8ef0c81b96bb", 1),
            SecurityScopeAttestation("7dcdeefd76ba8f6fae85a882452ad48f34b06ec27199cc325ee50926e215f619", 1),
            SecurityScopeAttestation("7e8f6b63ab4c4a97273f36a1563d4f33aefc85e5077f8be96d3c2e781c52cb68", 1),
            SecurityScopeAttestation("80db9d9cc1cccd073dd05f5612a38db7e225cc3405d67e42b122a9792630efa2", 1),
            SecurityScopeAttestation("85b56301ac7c7e86bbbedb64a7504a68403380e0092143a21fcf36331936543e", 1),
            SecurityScopeAttestation("8b6e38fe1a76fab53b4ee2d460f403d672d9352028851dba3f3e343e6a22c518", 1),
            SecurityScopeAttestation("8d09c801930ddfeeb739fe7de53d4b392ff9713440ecd55107d31b29f3432a11", 1),
            SecurityScopeAttestation("8dd09aba35f44cb13cec6b7b78d1dc5f7baa6f68c921013b8f14e9fe7116b467", 1),
            SecurityScopeAttestation("8ea0f7cff785545647388b50b5b3cafd703f0b8ddd1700666ac8365aa7490da5", 1),
            SecurityScopeAttestation("9157a565f0880860be0f1b5b27ecaf97234a6e97ab3511a2696c0c9797fa64d4", 1),
            SecurityScopeAttestation("924a4a624aac0dc1ed3b6f94be9137a50ba9ebe84847b023430350bbeab2b7c7", 1),
            SecurityScopeAttestation("961022ebaebee0ed19c58111a11bac7e967e74b674aa97f224ab26209ed5e47e", 1),
            SecurityScopeAttestation("986f89a74206d0b28d8b50c2e362a9bd28178f5fe69400e34b010fe4f1f1ff26", 1),
            SecurityScopeAttestation("99c356c13625dd3f1f18b51e976ef061ff97f27ebe8559c4eaaadb791dd66903", 1),
            SecurityScopeAttestation("9b41354451f54e0c686f9f7380cdd8557cdaab85a5a3d5680f3532173d428dd7", 1),
            SecurityScopeAttestation("9ec40dc387b55fd94804b4ef9273537712392dbe934d3f715e05152ea55206f0", 1),
            SecurityScopeAttestation("a002f9632e30937d60fe513d204544d023dfc1e2f6c541fa8e542fbf8a0771c4", 1),
            SecurityScopeAttestation("a1eb5d6c9210f799e9028b3c6c61d63baee029cf9b883b26d63ab54207db6d98", 1),
            SecurityScopeAttestation("a3677f0c06eb62ad80796e7352be019cb50d36199730bcb861f15eafc80fd44a", 1),
            SecurityScopeAttestation("a585df8b58fe6d4efe4729ed52824cf5ca4106cc12e11c4aabd63c74647d194f", 1),
            SecurityScopeAttestation("4476c577b3b65e1867594943c36804737dbe2624f72b2403d80f4470a82a40f1", 1),
            SecurityScopeAttestation("aa3bee987e2b532f57c900cdb2270615df3173a995f6c8548ff2c3a2ed985ab0", 1),
            SecurityScopeAttestation("ac563d0c130acf89c8d2ecdfc413d1cc5db307091c244955ca392f86935d08a2", 1),
            SecurityScopeAttestation("afea167c10e067faa1416f18c575b4c0d77ca1f4fe01f7175744f68e4463d806", 1),
            SecurityScopeAttestation("b39f2640352401897b7464805d6c3ac3ce2552f355de01efd329dd29fed0912f", 1),
            SecurityScopeAttestation("b48ff4e458a7998fe0c349300607d2d79063551e90b9c5f4f6ea5602f42dd295", 1),
            SecurityScopeAttestation("b6ee2451e5fe8841844c496b78ba3a0d6a12705988e4f1c02bcb26471e897aeb", 1),
            SecurityScopeAttestation("202bfd58ece15d3fb4e92ad352c9eff9f1025ea21db7adc9f28ee5083f22257b", 1),
            SecurityScopeAttestation("bbad0aed255e2d8c3b66b0dbbde6bcbb167727fba8ad292d3011eb13f6de05c8", 1),
            SecurityScopeAttestation("bd89d0993f96eb104c20169a63306b78ce2dd5382629c86418ed582e7b8f4cbc", 1),
            SecurityScopeAttestation("bdc2614431687ed4bd8325e85b9820669609aa94b108684b8872f608efd4962d", 1),
            SecurityScopeAttestation("c39fcf01ea4a3332468d853a3745f0f2a8588cfc62515f00e78e71bac71bc80a", 1),
            SecurityScopeAttestation("c4782ce46c3b059a2f20fb438a6a277dce80a02341233554ec398330ba44a6c0", 1),
            SecurityScopeAttestation("e17ecc4de23bf1493b95db5bea941cf46f0ff65bfb094a58374d91202f2d0200", 1),
            SecurityScopeAttestation("cba1ee728a845ff85ebcad351a27226de4b2655c8912bcccac38c0919b6d0125", 1),
            SecurityScopeAttestation("d046b43c78eac7f9c0abc24f819b21c937b819c6e1ef7e22d88b8f852b7a0fbe", 1),
            SecurityScopeAttestation("d23fbdcf5d3cd0d4d52fe01d3fc021dcd2d1a5175ab2740fadd5de3883607134", 1),
            SecurityScopeAttestation("d3121d6b4da00e39be71f9a34c2815b60074b8efdbf01ac0f5e4409a92860b1d", 1),
            SecurityScopeAttestation("d3755182e621bf5c04e0b40da225e689bf02de8892e5011b797adef523c9c485", 1),
            SecurityScopeAttestation("d458d79dfd7b79b31e4fc9944d6f25c21a99aa49ba6fb472a076b308df884b53", 1),
            SecurityScopeAttestation("d49c7508ceee362dd30a38f4177503f785f036c17f21a872ece28084b448304a", 1),
            SecurityScopeAttestation("d9f120ce3f5f7e368ab218401ef827d5604e7b7e37a246cc787804ff446fa0c0", 1),
            SecurityScopeAttestation("dcdaf0cbd903ade3b8c619c332af2f77578ed0979d473216a896aa4761678cb9", 1),
            SecurityScopeAttestation("e60578a09ec32070638d84c3d262b2108010c2537223e5f2bdc7d09faeec798b", 1),
            SecurityScopeAttestation("e6ebb096022645b3ee05a8f67c4a597753ec9ed10c0a8a096d1d26723364e78d", 1),
            SecurityScopeAttestation("e753bbe0e01d80bfd736717a208eaf8f158e31e45d46f6ed1fba6997cb61afae", 1),
            SecurityScopeAttestation("e7f6e50421e4d4a2e3404af2533bbb35402a081e9dc1e5e843f3b310c7f20143", 1),
            SecurityScopeAttestation("ea5a3ee6c6669cd92eaab732af2275e23dbe404bc889b24aff19da5665d15ebb", 1),
            SecurityScopeAttestation("ee09ac8c0a35032aa14ab63a94d50bd4a6f6378e898e76af5b08e19f02423567", 1),
            SecurityScopeAttestation("f2840855839ac063296cc606729ca5844294ea3a2c29ef6f6f2b7029f7e4fed8", 1),
            SecurityScopeAttestation("fe25d3cd0d050418a98f7d71d06d7f0a927cb07acad269980dd165c59101ce1c", 1),
        ),
    ),
    "server/admission.py": TrustedBoundary(
        module_fingerprint=(
            "682335c1b4bd81e5725702ab89102464c6279abdb41b73d347e444e2c14210ad"
        ),
        approved_capabilities=(
            CapabilityAttestation("durable", "0f18ee8fdcb6967b6fd77238872d58c46ecfffaef3e2db41d0812bc21fb94ed3", 1),
            CapabilityAttestation("durable", "41bb6862b9e67384b3b5bf4c6d2abfca15c92a15e6476ae98f0c5b06e4e655ad", 1),
            CapabilityAttestation("durable", "4e7660224a10225d5d36de126bf8627b22ab45310bfb9ce4879c7b7f849d84bb", 3),
            CapabilityAttestation("durable", "53ae361092cafa3b79d326d48440765d5abee76871ec43189346d97e6a728180", 2),
            CapabilityAttestation("durable", "75783dc68a2064d137e3377c77abd2e4e5b9ec74465b7e791684970e0a6a5135", 3),
            CapabilityAttestation("durable", "8349509b08b84e01224a9ccd4c8732a198d72179ab99ae6f579412cff44c22cb", 1),
            CapabilityAttestation("durable", "8a257d0743fd79683a2999d8cf64d756916d63b66e024145faccc37cdb19b3d9", 2),
            CapabilityAttestation("durable", "8bd04c74f45d8fce0a9dc935c4b4e84c25321dfab70b36bacef596827b624310", 1),
            CapabilityAttestation("durable", "fc0d32cb7a9f7cafd46a84dd71e5763fc6eadc3d2feebb5c384ff4d7c7b56b7d", 2),
        ),
        # Admission stores only HMAC-keyed counters and expiring opaque leases.
        approved_security_scopes=(
            SecurityScopeAttestation("038c0b108264c946c8b6a34b083b59f97a29a2b2bfb5f3abd3e1299145586a89", 1),
            SecurityScopeAttestation("04d1dd26566d0f7ec48b0b2706af6be1ed89f66146ab6fae9076075d477829ea", 1),
            SecurityScopeAttestation("056ff751f1ed3c108880197a022860feb7f2bcb4bde51f2aabe594486d722723", 1),
            SecurityScopeAttestation("05d499089e5ceb8949a053e890ac61bb6cfa9d695917b497d7100c844f44a07d", 1),
            SecurityScopeAttestation("09486374be17fcb175ef06e83f64809b37728d52003aadc78d2354eb0a07af73", 1),
            SecurityScopeAttestation("09c1a69518ae854315f21c257fd6e7495e0440f3b4615736844e6986b6a8e0f8", 1),
            SecurityScopeAttestation("0aa9c9b1f4582f00207e74b81becdfbd30b5bc9dcfe3b7e614eff764dbd8cb72", 1),
            SecurityScopeAttestation("19a797610c44f55246890c1104227b316eb038087540c2bf9fcd70524fb68636", 1),
            SecurityScopeAttestation("217bb7bcfe89ef4068c7942703544257805539b62c76940b271b24f2b69e7a8d", 1),
            SecurityScopeAttestation("39aba93bb0fdb8d40318fabedc9f7c8b4c283c380b07876017ec7f8e31c6e63e", 1),
            SecurityScopeAttestation("25aba28982881608db5d32ed0ef2daa93645ca7259d2bbb1639d37687354547b", 1),
            SecurityScopeAttestation("2aa44e84d29486eced5a629e3569959d7c9221c7867c805ae21d5ca14d7bc15c", 1),
            SecurityScopeAttestation("30ecd0c9ed49ce922f8c5a58264c18695a382d57e74792b1150c95c0e435e628", 1),
            SecurityScopeAttestation("447d6209290f3356530c440aa899054b2b16b8f54205df94127663b2a8ffb033", 1),
            SecurityScopeAttestation("41bb6862b9e67384b3b5bf4c6d2abfca15c92a15e6476ae98f0c5b06e4e655ad", 1),
            SecurityScopeAttestation("468f56a93c10055bc5fe1390c2f62deb538487885fce54436b5e92b5aaf555a6", 1),
            SecurityScopeAttestation("56368c0d75e76c681203a498d6cf63f937e80894ec4ad316ba7264a6eda17774", 1),
            SecurityScopeAttestation("5e39605659896cb5be462b492f33c391e9c105e7211e1c3396497eb86aba584d", 1),
            SecurityScopeAttestation("6e54d912b04cca30d311d00edef6abaf3065844ad908ace1376f47dc7cd36497", 1),
            SecurityScopeAttestation("6f031364e024c01515782d4c51014b3f557b479360992ac71cf6d23c78548c13", 1),
            SecurityScopeAttestation("76c0aa21cec69c28dd8bdcf1504d466c2e060e0806ce7c000a6dda3c09afce51", 1),
            SecurityScopeAttestation("786c4b04ea316a0237bf74d7fee868173176dc0969a6bb8ab1989d56289127b5", 1),
            SecurityScopeAttestation("789549cc67097a835dc3678a9f74a4f578e7e74f28c91d00461990fdf95d08e1", 1),
            SecurityScopeAttestation("7ebd201551a1df53bf2d1ce0ac83493494ee8e038779fd4457ed58f74162d673", 1),
            SecurityScopeAttestation("7efdf978211116cb7f1b07b3b21c687fb9ef440c2a39d29c2763c2f9cbc4db8b", 1),
            SecurityScopeAttestation("828b8efdeb63b72e6488ca89b9c6aeb7b997f6975bdd866d145ced1a83b705cf", 1),
            SecurityScopeAttestation("838708d90963236700f921e9c20e69ee2a4ed8bed16119689856f83ad72ce131", 1),
            SecurityScopeAttestation("84ddf7b91c2ce5a50ab1ff28eaea5166de803ea6eee32eeaa1c2f2b941a3b362", 1),
            SecurityScopeAttestation("87c6db4d8627208b3b1b4058011ebca43aa18464e8e64778a26f353684129f91", 1),
            SecurityScopeAttestation("452cb13054a82b3d0fb57b254ceae8b73a074c7914eda25690b77b3aa355b397", 1),
            SecurityScopeAttestation("54a8cea6ebac758179d300db01b5023b9140c989ba22c01ea64cc7d32308bf93", 1),
            SecurityScopeAttestation("c82b235f5693796e5afa66eea3f95587871cc2fdee4e682ee1c8082e96fce6fd", 1),
            SecurityScopeAttestation("6871e093d1debf8c4c001d532c4cdaf1832865b7a5e066cbc804498b9850269f", 1),
            SecurityScopeAttestation("94413aeadf8c91ae98d29e324d03733f8adc5a4341ab163f31696f2472d68700", 1),
            SecurityScopeAttestation("965245cf05ced7ed1afb51c6991195e996e458a64d1b515adf904b7423d69567", 1),
            SecurityScopeAttestation("a1eb5d6c9210f799e9028b3c6c61d63baee029cf9b883b26d63ab54207db6d98", 1),
            SecurityScopeAttestation("a461ac2bdfa9f84b6e65e8a76580a4ea90eaf93acd9dedc0fc9a36dfce9392d9", 1),
            SecurityScopeAttestation("aaa106a6b72ca63e1ebf8a353797ddc87293ec2d7426149051a7eda2ca8fa93f", 1),
            SecurityScopeAttestation("ac06ef096818502b1bcb08864c103d104f88977a3a26856a02a304c028c6e580", 1),
            SecurityScopeAttestation("ac563d0c130acf89c8d2ecdfc413d1cc5db307091c244955ca392f86935d08a2", 1),
            SecurityScopeAttestation("afd8713952d1c65440355e9de5075a414b59c15a6a0bad999318c434922934f4", 1),
            SecurityScopeAttestation("b24ae7536f790e7d9c10bd042188ce073d55fe4d428322889f769e52683f4936", 1),
            SecurityScopeAttestation("b29ceacfb099aeb623d9b4c3561616cd2871d88c6c9c7aba46d90300e8601084", 1),
            SecurityScopeAttestation("bc7ef8ff5485a98e791cde520c18f413d3f1874f2748d6b5b76b8880fb69a3db", 1),
            SecurityScopeAttestation("bd89d0993f96eb104c20169a63306b78ce2dd5382629c86418ed582e7b8f4cbc", 1),
            SecurityScopeAttestation("bd9f839ee55231f371a0e308c78c29a7481896a9a407da29311ccabc3d16bd7f", 1),
            SecurityScopeAttestation("bdd56f55b8699ba99cfcc468b22353e928a604e52531379aeacddf91e09853e8", 1),
            SecurityScopeAttestation("c52e318d6e3a195f5cb85d1194f71af4c73f083d0a30d573e00676e1cce8d5bb", 1),
            SecurityScopeAttestation("d01d6d76bcbe91ed53a1441c7708f930e656bd407d61d16e25ab76b0b3602ac8", 1),
            SecurityScopeAttestation("d08446b43f0f0edb687ea698efee7e1c0fb17918e2503e4aab14fdd4457ef211", 1),
            SecurityScopeAttestation("d8fd5ceeb197fcd9a2b6129717ba6da1835a7e703876da13e8f9008d726f41a2", 1),
            SecurityScopeAttestation("dadd7a6b648e7b9d68ef1efe41d7879366125f342209f260aafe2126f1fdf126", 1),
            SecurityScopeAttestation("e38e93a506cfb1c46eb03958fdbcf04e69115c52414645ed6d900076ae638b71", 1),
            SecurityScopeAttestation("ea11d9d9266d5c9349445097963044391bb02617283be360f8e21bf8461051d0", 1),
            SecurityScopeAttestation("ea5a3ee6c6669cd92eaab732af2275e23dbe404bc889b24aff19da5665d15ebb", 1),
            SecurityScopeAttestation("eb2d066adf4e99b2287d0514a7322dbb709fd91ddcf940eadfd24be03b561da5", 1),
            SecurityScopeAttestation("f2d023a3cba747b88cc5d168ab0cdf494c543cb5d748abdc9c8e5fec9592c72b", 1),
            SecurityScopeAttestation("f58692ca1fba04e47711fb7dbd36b5a3eb754372155de9f89549b3f713054539", 1),
            SecurityScopeAttestation("f816f849d7bf32d1f252c3213ff0f1c9c283982d909d174335b3a8d34aeac07c", 1),
            SecurityScopeAttestation("f94737b41792bf027666d4e2b6568ef52263d8b9c8e0d2951df61837d22149c4", 1),
            SecurityScopeAttestation("fb42563378c158755671bdad9e0da93a9abe814dd439998b09ffe16e0f9b0833", 1),
            SecurityScopeAttestation("fe25d3cd0d050418a98f7d71d06d7f0a927cb07acad269980dd165c59101ce1c", 1),
        ),
    ),
    "server/rate_limit.py": TrustedBoundary(
        module_fingerprint=(
            "30f02fa44930a96a9fdeeccbe57ce6b717ed6323f89ebfda905221c4c9e7903e"
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
                3,
            ),
            # transaction.execute (two call sites)
            CapabilityAttestation(
                "durable",
                "30ac02c88c7e8249dfba976649f2b0402089570462a0ef9287863cc38f6f1d60",
                3,
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
                3,
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
                3,
            ),
            # transaction.watch (two call sites)
            CapabilityAttestation(
                "durable",
                "9abd1a816ca44db2c96795248c1e10e7cdf422661b767435104d06e9415b547f",
                3,
            ),
            # transaction.incr
            CapabilityAttestation(
                "durable",
                "acc838fa929cc76572c7de20fb6d720d8f05a52d1b53b4cd6a3f5c53d74e5cbe",
                3,
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
                3,
            ),
            # ContextVar.set (two conservative set-capability matches)
            CapabilityAttestation(
                "durable",
                "f693074f0d94f9a6b9c70823f6edbacf88061ce0ca1f7698f716781fe571d065",
                2,
            ),
        ),
        # Mechanical CPython 3.12 Counter: every function/class scope plus
        # every top-level import and assignment in the trusted module.
        approved_security_scopes=(
            SecurityScopeAttestation("01a94bce2be478d6d8b882db9ef05a4000b9934b6cd3e4c9d839303939a8de75", 1),
            SecurityScopeAttestation("01f0c34fde4dc260b035a630bc5d88fb5a532e4d2ccbd16915d00a725432053b", 1),
            SecurityScopeAttestation("056ff751f1ed3c108880197a022860feb7f2bcb4bde51f2aabe594486d722723", 1),
            SecurityScopeAttestation("057b19a6413b4fccc58caa329f44a8e67bec8768a6a6bd54cb25384eed1198cd", 1),
            SecurityScopeAttestation("05d8de889ca2008d86f18c67b8bbdd3c0827da9ccf4c3613c34300933a0acde4", 1),
            SecurityScopeAttestation("0879e742986ee6b31329c891e5e58ad3e0d293b6e34270f9768a8f715511cad7", 1),
            SecurityScopeAttestation("09d5ef34d181eb10dca17aae6dd4c271c7cf12f882e316324310b7978c0bf08d", 1),
            SecurityScopeAttestation("11295ab715343fd02fa9b919b031c99e7242a7574cce7662485c1912abcfa4d5", 1),
            SecurityScopeAttestation("25c3172cfe4f053eee1b5ec2339dc44a3dd17ecd332f2584c26be23af25b7681", 1),
            SecurityScopeAttestation("38376088a57f201d5cd60192767e097994f51ece0f7c7abc0e71f1d4cc782c12", 1),
            SecurityScopeAttestation("3ef05d1e8866c60a3a864504c6cd740d67eb132ba89cfd248487b83a891b5154", 1),
            SecurityScopeAttestation("788e5e9f64b50617aec533d0645ddd67f217f79370337592aeba8b71d134264f", 1),
            SecurityScopeAttestation("85bf2fe5aff04c8d4a43774a14fbc489ab080aab29b36418ab2bc799f39292e4", 1),
            SecurityScopeAttestation("91e644557a8fb1a48bec0892577f5abc49bb11dd39484bae899405b01cd41e3d", 1),
            SecurityScopeAttestation("a1ee9e7b195f7be7af5882ea13f365d98b32c463742268d64396bf047e7d4f63", 1),
            SecurityScopeAttestation("e59371cc5d4aefeedac3c6724777065b2b0490293f6a0b63740b64f103f7093b", 1),
            SecurityScopeAttestation("e97dbf9fc74098deba2404e64d40cdf0991b3c6975dea6be1039ac8448ec7120", 1),
            SecurityScopeAttestation("f3856fccf2c4af114c377e7a583c9a3a80fbbbd9cd3e3fab0b25b16d4a9f082a", 1),
            SecurityScopeAttestation("1f2eab67e510e501526e704eb73860c1272eefd20ddc294dc639685adf591be9", 1),
            SecurityScopeAttestation("26ae916c3cfae485b6bdf751c411c382b0344d327465e64318b538dfe65bb384", 1),
            SecurityScopeAttestation("27deac5122477a5f6a7b6af1e99c9fd07747bb2bc87e6f06a5f111401f1b5bb7", 1),
            SecurityScopeAttestation("2c4493757d7d49316829a40a6469dd399a98b7b20e8a9485eb84d3fc00c435de", 1),
            SecurityScopeAttestation("31188bd8ca3d4fb1b1dbe92d7aabd7221a29186490a62c9c8826ade2aa790254", 1),
            SecurityScopeAttestation("3522a6dfb9f3e8434bddf0ffb0f69e867d4451a85da035ab60c87528414aac35", 1),
            SecurityScopeAttestation("3589c0927040d30cd4f5c0c18cbd142f26db58e0c05eee28c9406cde887db3cf", 1),
            SecurityScopeAttestation("374b61224d36afa6b6cb128d0cb866452c6e2ccc51935499482b95f41ad400e4", 1),
            SecurityScopeAttestation("3a20155993ea82ee8a5cf5bf5a85926830fb39a16bff234ff00c5b07aa3096c5", 1),
            SecurityScopeAttestation("41bb6862b9e67384b3b5bf4c6d2abfca15c92a15e6476ae98f0c5b06e4e655ad", 1),
            SecurityScopeAttestation("4b27ddde5ba4a5c76eebc507224428f536803c9057f8076bf7d7a8a018dd8f73", 1),
            SecurityScopeAttestation("4f9b8f94701c55f7bd17bdfe232a0df2c485c3cfa003c7d49c72ef168f68a40e", 1),
            SecurityScopeAttestation("526a2abf402edb4e4e0aba6bcb966a415e3eb5309c17e8fb045b1b8ba1063069", 1),
            SecurityScopeAttestation("536bcdebd23575330a29f16e9ae7f80f1d78b5d8c2d08d1ae17e94a9ec691b1f", 1),
            SecurityScopeAttestation("542ba0bd59082fec2d4845523a6fa67d655edcf4bae8931c6d35b7c1af57cfe2", 1),
            SecurityScopeAttestation("60db75ac2d4d9121f01af316ae1f4cebe0624a4b85597825c1d44959af0b2341", 1),
            SecurityScopeAttestation("63dd9d905960ca009825c400754c2ff0c1568ef50dc4e07eab2aff50802b1e3f", 1),
            SecurityScopeAttestation("64c38391a3bfbb9accb2a1973ac2bcb08905b68b967ba3a06ffe6a5f35e338b4", 1),
            SecurityScopeAttestation("68f5ba7161f9ddf276c0426af6f431d7faec3aca613e8b6a4cfac67958071d2b", 1),
            SecurityScopeAttestation("789549cc67097a835dc3678a9f74a4f578e7e74f28c91d00461990fdf95d08e1", 1),
            SecurityScopeAttestation("7d3cd2caaca23548d5281984ce2d5904f361736b0a6400f99456a8074adac378", 1),
            SecurityScopeAttestation("7e70a552fd9f537f01cf7ff1cf48b87a1a60f3e763b5e6fdde2bac02cb2c178e", 1),
            SecurityScopeAttestation("7e9f1e2d671a0e083333d433529317946508d0b93538574c9b7d9e8aec73c408", 1),
            SecurityScopeAttestation("805dd6b236b1c74144b5bbe8c41fad581e53f58936cfe929830cddb75247ba6b", 1),
            SecurityScopeAttestation("94261edcdf68f0066c4b352343ad2dd6ab97b79cfa01a8647e1e7a33dee797d9", 1),
            SecurityScopeAttestation("973d689365657e1fe766e12b1f5f58d8970f309a9660191a401ef77e2f360783", 1),
            SecurityScopeAttestation("9fae10a90858f7baa61dfadb69d89492c4fe09cf01ed7b306c9cd8076fdfa62e", 1),
            SecurityScopeAttestation("a1eb5d6c9210f799e9028b3c6c61d63baee029cf9b883b26d63ab54207db6d98", 1),
            SecurityScopeAttestation("ac563d0c130acf89c8d2ecdfc413d1cc5db307091c244955ca392f86935d08a2", 1),
            SecurityScopeAttestation("ae06405b96e35794b68c923e1e4d805f5d65c572cfeaaee3fa968547227ea518", 1),
            SecurityScopeAttestation("af5fd1daf045be635c9f43e029bee810b515fbe1b4f06734e8313e5e7e945109", 1),
            SecurityScopeAttestation("b5061f58ca0924a6c607d9b308c98c363a495f8546b8de08016e86afea8f93c7", 1),
            SecurityScopeAttestation("b5d71589f34034898328e0fb62e16a0c9c65b2a3bb3026149adf4c0ced99782b", 1),
            SecurityScopeAttestation("b844416e358d8da84a17a37a739388394a7af816194baf4c64b6e77e3a1a4ec4", 1),
            SecurityScopeAttestation("bd89d0993f96eb104c20169a63306b78ce2dd5382629c86418ed582e7b8f4cbc", 1),
            SecurityScopeAttestation("c42c549ac555439baa1adb3c87c17c34364a9b32e52ae24964969df4011d973c", 1),
            SecurityScopeAttestation("c52b9bdbfe11a36cfbac499c50f2957707650006fd6677ae23b515ea85c7875d", 1),
            SecurityScopeAttestation("c5904b45b4b5abaa124226846a1f6562b8bb4453931fc7dc86793893e8addf33", 1),
            SecurityScopeAttestation("c7dc3911192ef394d1ab46083ac6b29d9af719e4295956797354414e1f5338dc", 1),
            SecurityScopeAttestation("c994cd1971cad9038c734ff7a351099fe3b8ecba98d658febd8ef3ada5bf6249", 1),
            SecurityScopeAttestation("ced53ecf5003b94a7aa47102d17dcb385e26fdf7268209384d7207ea9fb7fd54", 1),
            SecurityScopeAttestation("cf7ca773746f0285b2d5cee0d513df27db55114a31661448aa5acaba43043285", 1),
            SecurityScopeAttestation("d116b387f1e75e49754f90d22abd1241e1506817faf596cc0db9cd408be3ad43", 1),
            SecurityScopeAttestation("d5b62c9871e30cecccd4386cfdca1c8cdeacde38cd955776524ddda25694482b", 1),
            SecurityScopeAttestation("d8fd5ceeb197fcd9a2b6129717ba6da1835a7e703876da13e8f9008d726f41a2", 1),
            SecurityScopeAttestation("dd44436483f3a9e4e6998b96fee3863617d7fc8627421fc69c0e817d9fbe1283", 1),
            SecurityScopeAttestation("ea11d9d9266d5c9349445097963044391bb02617283be360f8e21bf8461051d0", 1),
            SecurityScopeAttestation("f3a3532b34b75849f82e79cd50e3b44230377440f35989d7a95e13d9eaf4cf03", 1),
            SecurityScopeAttestation("f552e5df3f7a9727edb9e0d7dd5a28e8d0a6569a9a7ae696c0aed18777142853", 1),
            SecurityScopeAttestation("f81f8013ba7c1be8c18ca6ca77fa247930dc3cb68bebbc5d248b5c1c7ea25b07", 1),
            SecurityScopeAttestation("fe25d3cd0d050418a98f7d71d06d7f0a927cb07acad269980dd165c59101ce1c", 1),
        ),
    ),
    "server/app.py": TrustedBoundary(
        module_fingerprint=(
            "42ea21b0d0ba8e31de4ff70a861153a63a4679d82331d4c95363b23a4f31bf10"
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
        approved_security_scopes=(
            SecurityScopeAttestation("005dbf4b2a46b3c23a31d35feedab349a4073cbe6ae83f4baabbf4146558fcee", 1),
            SecurityScopeAttestation("1222e797ec463c55042234d5e95c4f78d4d4001dc6518c8bba73928ee9c0413e", 1),
            SecurityScopeAttestation("18aebaa69856080278f54328d8cef22aa5be314723c5896bd87aea9fb9b856df", 1),
            SecurityScopeAttestation("1bb89e34b7e21d63a4375d87cefbb8b66f194c99fe14a8025674e62c29c051b4", 1),
            SecurityScopeAttestation("2bd9469f0b02b50b1818640e3fc3787f75427691620c04e6706912629d88206f", 1),
            SecurityScopeAttestation("2e083104328b7a996e485aa017a269bae64659890674633bd2fab854caa00a32", 1),
            SecurityScopeAttestation("327b518701727f1905480df3067438b6e015bd9f4f0b740e5c129aa2c7a19a53", 1),
            SecurityScopeAttestation("3c277a5c45f99a192e8e02e5a98a04a3468c11fdb1c79937da8081142ca2625f", 1),
            SecurityScopeAttestation("3deda8f227a03487817e9ed3172e2d8eb733b3d54a21b6520381d5cb5ce16ee5", 1),
            SecurityScopeAttestation("3f1da7a69fc7c9873cab9feec0ca3e814642e414370683316343fdb54be1bf70", 1),
            SecurityScopeAttestation("4f67752ebb195a19308ebe3536577d9b872577e8f3b7d921c838159f5a6357af", 1),
            SecurityScopeAttestation("5043966e5abc6eaa5202af56b0985c3d12cedd794be03e76931baa4d2c987fc7", 1),
            SecurityScopeAttestation("568ad03ced02ed1c8e439daa0b9806ce6b675b4857527929ad10a90e29c63412", 1),
            SecurityScopeAttestation("59e30dd9f61b76da01c5dae045b4b4e671436c5dfa93a11e7695ccb2d616ed85", 1),
            SecurityScopeAttestation("60cb8a23aa3edaf117f5fd51244c88dbed49534aac213f6a3648adb4c53c8b67", 1),
            SecurityScopeAttestation("4902c037909440e199912b8ccaa863d33681f61ad29353b4105dfd7d5c915fc0", 1),
            SecurityScopeAttestation("ff1a2cf5becf9e5bb1e2a53f7437ff6439220f7d0b028072736f7afcec669942", 1),
            SecurityScopeAttestation("98493834f58f879b3c197bdee89c1c143c312149125e7b387017ea7f5e6be148", 1),
            SecurityScopeAttestation("a7c95592c33396cd17fbfc2d52a23a8c7ff8336bd8aa95157cf5119ffc4dc783", 1),
            SecurityScopeAttestation("7937bfeebdae869d99466370787244d1b0a26b59e07a826921b6494a6c1ce3df", 1),
            SecurityScopeAttestation("bc74446b3685c474820a65734b69512b2f1ef24988a380dd58afc2764511dcfb", 1),
            SecurityScopeAttestation("3ca978cb24812c84e331ad524ba4ac72b261c96133d06f3d43fe618c718a9216", 1),
            SecurityScopeAttestation("ed57173f86b8756f82e5b060fee41bee584b684890861d6ef998fd6b57b7f4a1", 1),
            SecurityScopeAttestation("f6758baf75398d28149a76a884b1f8b62e4e041768a21ce63f6b5a615d0ff2d2", 1),
            SecurityScopeAttestation("8a3880f52e8176ded0cd888ba1615ff98e7c68cd1794a7cd6ce5c0dae720105c", 1),
            SecurityScopeAttestation("8c6e58964f1661d063ab79debb75e6a23156d531e46c3a642c947f4f9eaa7c8a", 1),
            SecurityScopeAttestation("8dc6ba25e69e259f912bb34d0430506fe49cbc8af26ec97825a69b2f923892f7", 1),
            SecurityScopeAttestation("a2e9e10ca1ff2a6e44ec73b472c8eb69bb2e765b94dbc339501ffc94f0631879", 1),
            SecurityScopeAttestation("a38e14e4b2e14938cd5f6ebd34ef7ad9b5a8f10114efb7b4d473b3ed0aacbbfc", 1),
            SecurityScopeAttestation("a7ba9459b61c3de0ab9e2ff33a635e1e3d7026837d5b82b331a5e9a883e12d06", 1),
            SecurityScopeAttestation("bb8133ec04ce234af00ea88cdc928c3182c54ef24086a94516636835b08a1398", 1),
            SecurityScopeAttestation("be073a129125df08107ae370b48e7eb38ce0ed9a3fed1deadbd3c3154aaebe8f", 1),
            SecurityScopeAttestation("d8fd5ceeb197fcd9a2b6129717ba6da1835a7e703876da13e8f9008d726f41a2", 1),
            SecurityScopeAttestation("e176e239aa8cb44065f57dc167e3c53f6fc9bfd8d552da46b23aea6394f81043", 1),
            SecurityScopeAttestation("e389bc64f7c73a277eab1c8c907384cf00d6995b8db724ebaef0395f838f60ec", 1),
            SecurityScopeAttestation("7913f00acc13e596594d1fdbed11813fd80346a72085b8f93ad75b1339907f28", 1),
            SecurityScopeAttestation("5db7bd510f11141503e7ed087347851c52ad67ca386cbb114a7d8114e5842e58", 1),
            SecurityScopeAttestation("4d4e7e6c91eedbe4d07967d44bfd4fb1785af2508a85dba81e732b2b3863f36f", 1),
            SecurityScopeAttestation("ea11d9d9266d5c9349445097963044391bb02617283be360f8e21bf8461051d0", 1),
            SecurityScopeAttestation("ee09ac8c0a35032aa14ab63a94d50bd4a6f6378e898e76af5b08e19f02423567", 1),
            SecurityScopeAttestation("fe25d3cd0d050418a98f7d71d06d7f0a927cb07acad269980dd165c59101ce1c", 1),
        ),
    ),
    "server/gunicorn_logger.py": TrustedBoundary(
        module_fingerprint=(
            "ece60ef08260b60e62447a2fb3a81e3d8d687837c8615772fe7dee999a9514ba"
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
            # sys.stderr (write and flush receivers)
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
        approved_security_scopes=(
            SecurityScopeAttestation("03ffad9cd56fb7b8f5c90580d32db75f8ef06c0502aaedf1889f683780035758", 1),
            SecurityScopeAttestation("15487caf1cc50f24d19fb843c4a553b8473d9fb63f0e3cbae853cfff903c048a", 1),
            SecurityScopeAttestation("1f97a72df1e59046e9b632f0ab9d01deecdbfca300b0d86b92b9e09c3a1b97b2", 1),
            SecurityScopeAttestation("2cf24e7c4e0991fd9cae84a578776e60e41b058e9a67a7be352976ed3f3b61c5", 1),
            SecurityScopeAttestation("59e30dd9f61b76da01c5dae045b4b4e671436c5dfa93a11e7695ccb2d616ed85", 1),
            SecurityScopeAttestation("af7b0c07c8c4544d4e5800ad94e3ab53537775c960105fc68d9e80628045e73f", 1),
            SecurityScopeAttestation("fcf9fbfd3bdf4d022209610ca09b126e264c3dd7465c71fc69ee48f7b42a93ad", 1),
            SecurityScopeAttestation("e389bc64f7c73a277eab1c8c907384cf00d6995b8db724ebaef0395f838f60ec", 1),
            SecurityScopeAttestation("fe25d3cd0d050418a98f7d71d06d7f0a927cb07acad269980dd165c59101ce1c", 1),
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


def _security_scope_counter(tree: ast.Module) -> Counter[str]:
    scope_types = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)
    top_level_dependency_types: tuple[type[ast.AST], ...] = (
        ast.Import,
        ast.ImportFrom,
        ast.Assign,
        ast.AnnAssign,
        ast.AugAssign,
    )
    type_alias = getattr(ast, "TypeAlias", None)
    if isinstance(type_alias, type):
        top_level_dependency_types += (type_alias,)
    nodes = [node for node in ast.walk(tree) if isinstance(node, scope_types)]
    nodes.extend(
        node for node in tree.body if isinstance(node, top_level_dependency_types)
    )
    return Counter(_node_fingerprint(node) for node in nodes)


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
    expected_scopes = Counter(
        approved.fingerprint
        for approved in boundary.approved_security_scopes
        for _ in range(approved.count)
    )
    if (
        _node_fingerprint(tree) != boundary.module_fingerprint
        or observed != expected
        or _security_scope_counter(tree) != expected_scopes
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


@dataclass
class _LexicalScope:
    kind: str
    bound_names: set[str]
    aliases: dict[str, str]
    global_names: set[str]
    nonlocal_names: set[str]


class _LocalBindingCollector(ast.NodeVisitor):
    def __init__(self) -> None:
        self.bound_names: set[str] = set()
        self.global_names: set[str] = set()
        self.nonlocal_names: set[str] = set()

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Store):
            self.bound_names.add(node.id)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.bound_names.add(node.name)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self.bound_names.add(node.name)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.bound_names.add(node.name)

    def visit_Lambda(self, node: ast.Lambda) -> None:
        return

    def visit_ListComp(self, node: ast.ListComp) -> None:
        return

    def visit_SetComp(self, node: ast.SetComp) -> None:
        return

    def visit_DictComp(self, node: ast.DictComp) -> None:
        return

    def visit_GeneratorExp(self, node: ast.GeneratorExp) -> None:
        return

    def visit_Import(self, node: ast.Import) -> None:
        self.bound_names.update(
            alias.asname or alias.name.split(".", 1)[0] for alias in node.names
        )

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        self.bound_names.update(alias.asname or alias.name for alias in node.names)

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        if node.name is not None:
            self.bound_names.add(node.name)
        self.generic_visit(node)

    def visit_Global(self, node: ast.Global) -> None:
        self.global_names.update(node.names)

    def visit_Nonlocal(self, node: ast.Nonlocal) -> None:
        self.nonlocal_names.update(node.names)


def _function_lexical_scope(
    node: ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda,
) -> _LexicalScope:
    collector = _LocalBindingCollector()
    body = [node.body] if isinstance(node, ast.Lambda) else node.body
    for statement in body:
        collector.visit(statement)
    arguments = node.args
    collector.bound_names.update(
        argument.arg
        for argument in (
            *arguments.posonlyargs,
            *arguments.args,
            *arguments.kwonlyargs,
        )
    )
    if arguments.vararg is not None:
        collector.bound_names.add(arguments.vararg.arg)
    if arguments.kwarg is not None:
        collector.bound_names.add(arguments.kwarg.arg)
    collector.bound_names.difference_update(
        collector.global_names | collector.nonlocal_names
    )
    return _LexicalScope(
        kind="function",
        bound_names=collector.bound_names,
        aliases={},
        global_names=collector.global_names,
        nonlocal_names=collector.nonlocal_names,
    )


class ArchitecturalSinkVisitor(ast.NodeVisitor):
    """Discover exact storage, logging, and dynamic capability AST nodes."""

    def __init__(self) -> None:
        self.capability_nodes: dict[str, dict[int, ast.AST]] = {
            policy: {} for policy in CAPABILITY_RULES
        }
        self._module_aliases: dict[str, str] = {}
        self._scopes: list[_LexicalScope] = []
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

    def _canonical_callable_kind(self, canonical: str | None) -> str | None:
        if canonical in {"open", "builtins.open"} | READABLE_OPEN_CAPABILITIES:
            return "open"
        if canonical in LOGGING_CANONICAL_CAPABILITIES:
            return "logging"
        if canonical in {"getattr", "builtins.getattr"}:
            return "getattr"
        if canonical in {"vars", "builtins.vars"}:
            return "vars"
        if canonical in DYNAMIC_BUILTINS | DYNAMIC_CANONICAL_CAPABILITIES:
            return "dynamic"
        if canonical is not None and canonical.startswith("importlib."):
            return "dynamic"
        return None

    def _resolved_name_kind(self, name: str) -> tuple[bool, str | None]:
        if not self._scopes:
            return False, BUILTIN_CALLABLE_KINDS.get(name)
        current = self._scopes[-1]
        if current.kind == "function" and name in current.global_names:
            scopes = self._scopes[:1]
        else:
            scopes = self._scopes
        crossed_function = False
        for scope in reversed(scopes):
            if scope.kind == "class" and crossed_function:
                continue
            if name in scope.aliases:
                return True, scope.aliases[name]
            if name in scope.bound_names:
                return True, None
            if scope.kind == "function":
                crossed_function = True
        if name in BUILTIN_CALLABLE_KINDS:
            return True, BUILTIN_CALLABLE_KINDS[name]
        return False, None

    def _callable_kind(self, node: ast.AST | None) -> str | None:
        if isinstance(node, ast.Name):
            resolved, kind = self._resolved_name_kind(node.id)
            if resolved:
                return kind
        return self._canonical_callable_kind(self._canonical_name(node))

    def _binding_scope(self, name: str) -> _LexicalScope:
        current = self._scopes[-1]
        if current.kind == "function" and name in current.global_names:
            return self._scopes[0]
        if current.kind == "function" and name in current.nonlocal_names:
            for scope in reversed(self._scopes[:-1]):
                if scope.kind == "function" and name in scope.bound_names:
                    return scope
        return current

    def _bind_name(self, name: str, kind: str | None = None) -> None:
        scope = self._binding_scope(name)
        scope.bound_names.add(name)
        scope.aliases.pop(name, None)
        if kind is not None:
            scope.aliases[name] = kind

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

    def visit_Module(self, node: ast.Module) -> None:
        self._scopes.append(
            _LexicalScope("module", set(), {}, set(), set())
        )
        for statement in node.body:
            self.visit(statement)
        self._scopes.pop()

    def _visit_function(
        self, node: ast.FunctionDef | ast.AsyncFunctionDef
    ) -> None:
        for decorator in node.decorator_list:
            self.visit(decorator)
        self.visit(node.args)
        if node.returns is not None:
            self.visit(node.returns)
        for type_parameter in getattr(node, "type_params", ()):
            self.visit(type_parameter)
        self._bind_name(node.name)
        self._scopes.append(_function_lexical_scope(node))
        for statement in node.body:
            self.visit(statement)
        self._scopes.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_function(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_function(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        for decorator in node.decorator_list:
            self.visit(decorator)
        for base in node.bases:
            self.visit(base)
        for keyword in node.keywords:
            self.visit(keyword.value)
        for type_parameter in getattr(node, "type_params", ()):
            self.visit(type_parameter)
        self._bind_name(node.name)
        self._scopes.append(
            _LexicalScope("class", set(), {}, set(), set())
        )
        for statement in node.body:
            self.visit(statement)
        self._scopes.pop()

    def visit_Lambda(self, node: ast.Lambda) -> None:
        self.visit(node.args)
        self._scopes.append(_function_lexical_scope(node))
        self.visit(node.body)
        self._scopes.pop()

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
            if root in DYNAMIC_MODULE_ROOTS:
                self._add_dynamic(node)
            self._bind_name(bound)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = node.module or ""
        root = module.split(".", 1)[0]
        for alias in node.names:
            bound = alias.asname or alias.name
            canonical = f"{module}.{alias.name}" if module else alias.name
            self._module_aliases[bound] = canonical
            kind = self._canonical_callable_kind(canonical)
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
            if kind == "logging":
                self._add_logging(node)
            if kind in {"getattr", "vars", "dynamic"}:
                self._add_dynamic(node)
            if root == "logging" or module == "gunicorn.glogging":
                self._logging_receivers.add((bound,))
                self._add_logging(node)
            if root in DYNAMIC_MODULE_ROOTS:
                self._add_dynamic(node)
            self._bind_name(bound, kind)

    def _record_assignment(self, name: str, value: ast.AST) -> None:
        path = (name,)
        self._durable_receivers.discard(path)
        self._path_values.discard(path)
        self._memory_values.discard(path)
        self._reflection_maps.discard(path)
        self._logging_receivers.discard(path)

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
        self._bind_name(name, callable_kind)

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
        elif kind == "logging":
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
        if canonical in LOGGING_CANONICAL_CAPABILITIES:
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

        if kind == "logging":
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


def verify_artifacts(
    paths: tuple[Path, ...],
    *,
    forbidden_values: tuple[str, ...],
) -> tuple[str, ...]:
    if len(paths) > 32 or len(forbidden_values) > 64:
        return ("artifact-input-bound",)
    normalized_forbidden: list[str] = []
    for value in forbidden_values:
        if (
            not isinstance(value, str)
            or not 8 <= len(value) <= 4_096
            or "\x00" in value
        ):
            return ("forbidden-value-contract",)
        normalized_forbidden.append(value)

    findings: set[str] = set()
    for path in paths:
        try:
            metadata = path.lstat()
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_size < 0
                or metadata.st_size > ARTIFACT_MAX_BYTES
            ):
                findings.add("artifact-file-contract")
                continue
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            findings.add("artifact-file-contract")
            continue
        for name, pattern in ARTIFACT_RULES:
            if pattern.search(content):
                findings.add(name)
        if any(value in content for value in normalized_forbidden):
            findings.add("forbidden-value")
    return tuple(sorted(findings))


def _private_forbidden_values(paths: tuple[Path, ...]) -> tuple[str, ...]:
    values: list[str] = []
    if len(paths) > 16:
        raise ValueError
    for path in paths:
        metadata = path.lstat()
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_mode & 0o777 != 0o600
            or metadata.st_size <= 0
            or metadata.st_size > 64 * 1024
        ):
            raise ValueError
        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(path, flags)
        try:
            raw = os.read(descriptor, 64 * 1024 + 1)
        finally:
            os.close(descriptor)
        if len(raw) > 64 * 1024:
            raise ValueError
        decoded = raw.decode("utf-8")
        values.extend(line for line in decoded.splitlines() if line)
    return tuple(values)


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
    parser.add_argument("--artifact", action="append", type=Path, default=[])
    parser.add_argument(
        "--forbidden-value-file", action="append", type=Path, default=[]
    )
    args = parser.parse_args()
    result = verify(args.root.resolve())
    if result != 0:
        return result
    try:
        forbidden_values = _private_forbidden_values(
            tuple(args.forbidden_value_file)
        )
    except (OSError, UnicodeError, ValueError):
        print(
            "Sensitive-retention artifact verification failed: private comparison values are unavailable.",
            file=sys.stderr,
        )
        return 2
    findings = verify_artifacts(
        tuple(args.artifact),
        forbidden_values=forbidden_values,
    )
    if findings:
        print(
            f"Sensitive-retention artifact verification failed: {len(findings)} bounded rule"
            f"{'s' if len(findings) != 1 else ''}.",
            file=sys.stderr,
        )
        for finding in findings:
            print(f"- {finding}", file=sys.stderr)
        return 1
    if args.artifact:
        print("Sensitive-retention artifact verification passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
