from __future__ import annotations

import sys
from typing import Any

from gunicorn.glogging import Logger


def write_content_free_metric(value: str) -> None:
    """Write a telemetry line whose schema was validated before this boundary."""
    sys.stderr.write(value)
    sys.stderr.flush()


class ContentFreeGunicornLogger(Logger):
    """Keep Gunicorn operational logs while removing request-derived values."""

    def warning(self, msg: object, *args: object, **kwargs: object) -> None:
        if isinstance(msg, str) and msg.startswith("Invalid request from ip="):
            super().warning("Rejected malformed HTTP request.")
            return
        super().warning(msg, *args, **kwargs)

    def exception(self, msg: object, *args: object, **kwargs: object) -> None:
        if isinstance(msg, str) and msg.startswith("Error handling request"):
            super().error("Request handling failed.")
            return
        super().exception(msg, *args, **kwargs)

    def access(
        self,
        resp: Any,
        req: Any,
        environ: Any,
        request_time: Any,
    ) -> None:
        return
