#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess


def _git_diff_check(*arguments: str) -> int:
    result = subprocess.run(
        ["git", *arguments],
        check=False,
    )
    return result.returncode


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--event-name", choices=("pull_request", "push"), required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--base", default="")
    parser.add_argument("--before", default="")
    arguments = parser.parse_args()

    if arguments.event_name == "pull_request":
        if not arguments.base:
            parser.error("--base is required for pull_request")
        committed_status = _git_diff_check(
            "diff",
            "--check",
            f"{arguments.base}...{arguments.head}",
        )
    elif arguments.before and set(arguments.before) == {"0"}:
        committed_status = _git_diff_check(
            "show",
            "--check",
            "--format=",
            arguments.head,
        )
    else:
        if not arguments.before:
            parser.error("--before is required for push")
        committed_status = _git_diff_check(
            "diff",
            "--check",
            f"{arguments.before}..{arguments.head}",
        )

    worktree_status = _git_diff_check("diff", "--check")
    return 1 if committed_status != 0 or worktree_status != 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
