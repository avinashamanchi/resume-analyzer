from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any


class BoundedJsonError(ValueError):
    def __init__(self) -> None:
        super().__init__("bounded_json_invalid")


class _InvalidJson(ValueError):
    pass


def _object_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _InvalidJson
        result[key] = value
    return result


def _reject_constant(_value: str) -> None:
    raise _InvalidJson


def decode_bounded_json(body: bytes, *, max_bytes: int) -> Any:
    if (
        not isinstance(body, bytes)
        or isinstance(max_bytes, bool)
        or not isinstance(max_bytes, int)
        or max_bytes <= 0
        or len(body) > max_bytes
    ):
        raise BoundedJsonError()
    failed = False
    decoded: Any = None
    try:
        text = body.decode("utf-8", errors="strict")
        decoded = json.loads(
            text,
            object_pairs_hook=_object_without_duplicates,
            parse_constant=_reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, _InvalidJson, RecursionError):
        failed = True
    if failed:
        raise BoundedJsonError()
    return decoded


def read_bounded_json(response: Any, *, max_bytes: int) -> Any:
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes <= 0:
        raise BoundedJsonError()
    declared = response.headers.get("Content-Length")
    if declared is not None:
        if not declared.isascii() or not declared.isdigit():
            raise BoundedJsonError()
        declared_length = int(declared)
        if declared_length > max_bytes:
            raise BoundedJsonError()
    body = bytearray()
    failed = False
    try:
        chunks: Iterable[bytes] = response.iter_bytes(chunk_size=16_384)
        for chunk in chunks:
            if not isinstance(chunk, bytes) or len(body) + len(chunk) > max_bytes:
                failed = True
                break
            body.extend(chunk)
    except Exception:
        failed = True
    if failed:
        raise BoundedJsonError()
    return decode_bounded_json(bytes(body), max_bytes=max_bytes)
