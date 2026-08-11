#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

from server.installations import InstallationTokenService
from server.production import _runtime_key


MAX_PRINCIPALS = 25_000
MAX_KEY_BYTES = 1_024


class TokenGenerationError(ValueError):
    pass


def write_installation_tokens(
    destination: Path,
    *,
    count: int,
    signing_key: bytes,
    repository_root: Path,
) -> None:
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= MAX_PRINCIPALS:
        raise TokenGenerationError("count must be between 1 and 25000")
    if not isinstance(signing_key, bytes) or not 32 <= len(signing_key) <= MAX_KEY_BYTES:
        raise TokenGenerationError("one-run signing key is invalid")
    if b"\x00" in signing_key or b"\r" in signing_key or b"\n" in signing_key:
        raise TokenGenerationError("one-run signing key is invalid")
    root = repository_root.resolve(strict=True)
    output = destination.expanduser().resolve(strict=False)
    try:
        output.relative_to(root)
    except ValueError:
        pass
    else:
        raise TokenGenerationError("token output must be outside the repository")
    output.parent.resolve(strict=True)

    service = InstallationTokenService(
        _runtime_key(signing_key.decode("utf-8"), b"installation-token"),
        revenuecat_identity_key=_runtime_key(
            signing_key.decode("utf-8"),
            b"revenuecat-installation-identity",
        ),
    )
    tokens = [service.issue_v2().installation_token for _ in range(count)]
    if len(set(tokens)) != count:
        raise TokenGenerationError("token generator did not produce unique principals")
    payload = json.dumps(
        {"schemaVersion": 1, "principalCount": count, "tokens": tokens},
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("ascii")

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(output, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(descriptor)
    if os.stat(output, follow_symlinks=False).st_mode & 0o777 != 0o600:
        raise TokenGenerationError("token output permissions are not mode 0600")


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate one-run staging installation tokens.")
    parser.add_argument("--count", required=True, type=int)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--key-stdin", action="store_true", required=True)
    arguments = parser.parse_args()
    del arguments.key_stdin
    key = sys.stdin.buffer.read(MAX_KEY_BYTES + 2)
    if key.endswith(b"\n"):
        key = key[:-1]
    try:
        write_installation_tokens(
            arguments.output,
            count=arguments.count,
            signing_key=key,
            repository_root=Path(__file__).resolve().parents[2],
        )
    except (OSError, UnicodeError, TokenGenerationError, ValueError):
        print("Staging token generation failed.", file=sys.stderr)
        return 1
    print(f"Generated {arguments.count} one-run staging principals.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
