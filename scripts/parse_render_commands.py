#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shlex
import sys
from typing import Any

import yaml


def _tokenize(commands: list[str]) -> list[dict[str, Any]]:
    parsed: list[dict[str, Any]] = []
    for command in commands:
        stripped = command.strip()
        lexer = shlex.shlex(
            stripped,
            posix=True,
            punctuation_chars=";&|<>()",
        )
        lexer.commenters = ""
        lexer.whitespace_split = True
        parsed.append(
            {
                "hasInternalLineBreak": "\n" in stripped or "\r" in stripped,
                "tokens": list(lexer),
            }
        )
    return parsed


def _render_commands(content: str) -> list[str]:
    document = yaml.safe_load(content)
    if not isinstance(document, dict):
        raise ValueError("Render document must be a mapping")
    services = document.get("services")
    if not isinstance(services, list):
        raise ValueError("Render services must be a list")
    commands: list[str] = []
    for service in services:
        if not isinstance(service, dict):
            raise ValueError("Render service must be a mapping")
        if "startCommand" not in service:
            continue
        command = service["startCommand"]
        if not isinstance(command, str) or not command.strip():
            raise ValueError("Render start command must be text")
        commands.append(command)
    return commands


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("mode", choices=("render", "commands"))
    arguments = parser.parse_args()
    try:
        content = sys.stdin.read()
        if arguments.mode == "render":
            commands = _render_commands(content)
        else:
            decoded = json.loads(content)
            if not isinstance(decoded, list) or not all(
                isinstance(command, str) for command in decoded
            ):
                raise ValueError("Commands must be text")
            commands = decoded
        sys.stdout.write(json.dumps(_tokenize(commands), separators=(",", ":")))
    except (ValueError, json.JSONDecodeError, yaml.YAMLError):
        print("Command parsing failed.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
