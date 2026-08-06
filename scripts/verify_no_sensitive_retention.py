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
            SecurityScopeAttestation("1bfb24e9e2975908c35d5ebeee0d07a48eb605149bb399f75629df7d5317f5a5", 1),
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
            SecurityScopeAttestation("65e88aa2fd697edc39d97565c7eafa024129633ce83858ec1e5094452b776f11", 1),
            SecurityScopeAttestation("8a3880f52e8176ded0cd888ba1615ff98e7c68cd1794a7cd6ce5c0dae720105c", 1),
            SecurityScopeAttestation("8c6e58964f1661d063ab79debb75e6a23156d531e46c3a642c947f4f9eaa7c8a", 1),
            SecurityScopeAttestation("8dc6ba25e69e259f912bb34d0430506fe49cbc8af26ec97825a69b2f923892f7", 1),
            SecurityScopeAttestation("9376855c629bcd9718a789018b150168a06fde0f6e7e2838d0f36da1c98a429e", 1),
            SecurityScopeAttestation("a2e9e10ca1ff2a6e44ec73b472c8eb69bb2e765b94dbc339501ffc94f0631879", 1),
            SecurityScopeAttestation("a38e14e4b2e14938cd5f6ebd34ef7ad9b5a8f10114efb7b4d473b3ed0aacbbfc", 1),
            SecurityScopeAttestation("a7ba9459b61c3de0ab9e2ff33a635e1e3d7026837d5b82b331a5e9a883e12d06", 1),
            SecurityScopeAttestation("af5950e2ab77ddef271805864f553df3334cc3f9d5c63d5d790f874f04a43d57", 1),
            SecurityScopeAttestation("bb8133ec04ce234af00ea88cdc928c3182c54ef24086a94516636835b08a1398", 1),
            SecurityScopeAttestation("be073a129125df08107ae370b48e7eb38ce0ed9a3fed1deadbd3c3154aaebe8f", 1),
            SecurityScopeAttestation("d8fd5ceeb197fcd9a2b6129717ba6da1835a7e703876da13e8f9008d726f41a2", 1),
            SecurityScopeAttestation("e176e239aa8cb44065f57dc167e3c53f6fc9bfd8d552da46b23aea6394f81043", 1),
            SecurityScopeAttestation("e389bc64f7c73a277eab1c8c907384cf00d6995b8db724ebaef0395f838f60ec", 1),
            SecurityScopeAttestation("e75748f30137a2612c3db979a0fb860b85681dd53d219fd2cc415699ae770660", 1),
            SecurityScopeAttestation("ea11d9d9266d5c9349445097963044391bb02617283be360f8e21bf8461051d0", 1),
            SecurityScopeAttestation("ee09ac8c0a35032aa14ab63a94d50bd4a6f6378e898e76af5b08e19f02423567", 1),
            SecurityScopeAttestation("f1a5cbb2372708555c91ad79d7c7f5d9fdaf9267116459aed2a5d417f6fcee5e", 1),
            SecurityScopeAttestation("f6d94c7eb407c7ab5e4a81a507b30cfb93bc854d0d385540fc18f97c11b74138", 1),
            SecurityScopeAttestation("fd39984cd5a9ccd66728b403e18729d7d02538083969d4d22a463ef8da46cd5f", 1),
            SecurityScopeAttestation("fe25d3cd0d050418a98f7d71d06d7f0a927cb07acad269980dd165c59101ce1c", 1),
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
        approved_security_scopes=(
            SecurityScopeAttestation("03ffad9cd56fb7b8f5c90580d32db75f8ef06c0502aaedf1889f683780035758", 1),
            SecurityScopeAttestation("15487caf1cc50f24d19fb843c4a553b8473d9fb63f0e3cbae853cfff903c048a", 1),
            SecurityScopeAttestation("1f97a72df1e59046e9b632f0ab9d01deecdbfca300b0d86b92b9e09c3a1b97b2", 1),
            SecurityScopeAttestation("2cf24e7c4e0991fd9cae84a578776e60e41b058e9a67a7be352976ed3f3b61c5", 1),
            SecurityScopeAttestation("59e30dd9f61b76da01c5dae045b4b4e671436c5dfa93a11e7695ccb2d616ed85", 1),
            SecurityScopeAttestation("af7b0c07c8c4544d4e5800ad94e3ab53537775c960105fc68d9e80628045e73f", 1),
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
