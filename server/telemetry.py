from __future__ import annotations

from dataclasses import dataclass
import json
import math
from typing import Callable, Literal, Mapping, Protocol


class TelemetryContractError(ValueError):
    """Raised before an unbounded or sensitive metric can reach a sink."""


class TelemetrySink(Protocol):
    def emit(self, record: dict[str, object]) -> None: ...


_LABEL_VALUES: dict[str, frozenset[str]] = {
    "route": frozenset(
        {
            "root",
            "static",
            "health",
            "installations_v1",
            "installations_v2",
            "analyses_v1",
            "analyses_v2",
            "entitlements_sync_v2",
            "identity_apple_v2",
            "revenuecat_webhook_v2",
            "identity_canary_v2",
            "capacity_snapshot_v2",
            "preflight",
            "not_found",
            "other",
        }
    ),
    "status_class": frozenset({"2xx", "3xx", "4xx", "5xx"}),
    "plan_class": frozenset({"free", "pro", "unknown"}),
    "source_class": frozenset({"reviewed_text", "pdf", "unknown"}),
    "ai_status": frozenset(
        {
            "admitted",
            "not_requested",
            "complete",
            "quota_exhausted",
            "plan_verification_unavailable",
            "temporarily_unavailable",
            "timeout",
            "invalid_provider_response",
            "unknown",
        }
    ),
    "admission_outcome": frozenset(
        {
            "admitted",
            "not_requested",
            "quota_exhausted",
            "plan_verification_unavailable",
            "temporarily_unavailable",
            "rate_limited",
            "capacity_limited",
            "invalid",
            "unknown",
        }
    ),
    "provider_outcome": frozenset(
        {
            "complete",
            "timeout",
            "invalid_response",
            "unavailable",
            "not_requested",
            "unknown",
        }
    ),
    "pdf_outcome": frozenset(
        {
            "complete",
            "invalid",
            "encrypted",
            "too_large",
            "unavailable",
            "not_requested",
            "unknown",
        }
    ),
}


@dataclass(frozen=True, slots=True)
class _MetricSpec:
    labels: tuple[str, ...]
    buckets: tuple[float, ...] = ()
    minimum: float = 0
    maximum: float = float("inf")


_COUNTERS = {
    "http_requests": _MetricSpec(("route", "status_class")),
    "analysis": _MetricSpec(("source_class", "ai_status", "plan_class")),
    "admission": _MetricSpec(("source_class", "admission_outcome")),
    "provider": _MetricSpec(("provider_outcome",)),
    "pdf": _MetricSpec(("pdf_outcome",)),
}
_HISTOGRAMS = {
    "admission_latency_ms": _MetricSpec(
        ("source_class", "admission_outcome"),
        (1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000),
    ),
    "scoring_latency_ms": _MetricSpec(
        ("source_class",),
        (1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000),
    ),
    "pdf_latency_ms": _MetricSpec(
        ("pdf_outcome",),
        (10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000),
    ),
    "provider_latency_ms": _MetricSpec(
        ("provider_outcome",),
        (10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000),
    ),
    "total_latency_ms": _MetricSpec(
        ("route", "status_class"),
        (5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 60_000),
    ),
}
_GAUGES = {
    "provider_slots": _MetricSpec((), maximum=48),
    "pdf_slots": _MetricSpec((), maximum=8),
    "local_pdf_slots": _MetricSpec((), maximum=2),
    "local_declared_pdf_bytes": _MetricSpec((), maximum=20 * 1024 * 1024),
    "redis_health": _MetricSpec((), maximum=1),
}


def _validated_labels(
    supplied: Mapping[str, str],
    expected: tuple[str, ...],
) -> dict[str, str]:
    if not isinstance(supplied, Mapping) or set(supplied) != set(expected):
        raise TelemetryContractError("Telemetry labels do not match the fixed schema.")
    normalized: dict[str, str] = {}
    for name in expected:
        value = supplied.get(name)
        if type(value) is not str or value not in _LABEL_VALUES[name]:
            raise TelemetryContractError("Telemetry contains an unknown label value.")
        normalized[name] = value
    return normalized


def _number(value: int | float, spec: _MetricSpec) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TelemetryContractError("Telemetry values must be finite numbers.")
    converted = float(value)
    if (
        not math.isfinite(converted)
        or converted < spec.minimum
        or converted > spec.maximum
    ):
        raise TelemetryContractError("Telemetry value is outside its fixed range.")
    return converted


class ContentFreeJsonSink:
    """Write already-validated metric records as bounded JSON lines."""

    def __init__(self, write: Callable[[str], object]) -> None:
        if not callable(write):
            raise TypeError("write must be callable")
        self._write = write

    def emit(self, record: dict[str, object]) -> None:
        if not isinstance(record, dict):
            raise TelemetryContractError("Telemetry records must be mappings.")
        try:
            rendered = json.dumps(
                record,
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
                allow_nan=False,
            )
        except (TypeError, ValueError):
            raise TelemetryContractError("Telemetry record is not serializable.") from None
        if "\n" in rendered or len(rendered.encode("utf-8")) + 1 > 1_024:
            raise TelemetryContractError("Telemetry record is not bounded.")
        self._write(rendered + "\n")


class Telemetry:
    """Fixed-cardinality operational telemetry with no content or identifiers."""

    def __init__(self, *, sink: TelemetrySink) -> None:
        emit = getattr(sink, "emit", None)
        if not callable(emit):
            raise TypeError("sink must expose emit(record)")
        self._sink = sink

    def counter(self, name: str, labels: Mapping[str, str]) -> None:
        self._emit("counter", name, 1, labels, _COUNTERS)

    def histogram(
        self,
        name: str,
        value: int | float,
        labels: Mapping[str, str],
    ) -> None:
        spec = _HISTOGRAMS.get(name)
        if spec is None:
            raise TelemetryContractError("Unknown telemetry histogram.")
        normalized_value = _number(value, spec)
        normalized_labels = _validated_labels(labels, spec.labels)
        bucket: float | Literal["+Inf"] = "+Inf"
        for boundary in spec.buckets:
            if normalized_value <= boundary:
                bucket = boundary
                break
        self._sink.emit(
            {
                "schemaVersion": 1,
                "kind": "histogram",
                "name": name,
                "labels": normalized_labels,
                "value": normalized_value,
                "bucket": bucket,
            }
        )
    def gauge(
        self,
        name: str,
        value: int | float,
        labels: Mapping[str, str],
    ) -> None:
        self._emit("gauge", name, value, labels, _GAUGES)

    def _emit(
        self,
        kind: Literal["counter", "gauge"],
        name: str,
        value: int | float,
        labels: Mapping[str, str],
        vocabulary: Mapping[str, _MetricSpec],
    ) -> None:
        spec = vocabulary.get(name)
        if spec is None:
            raise TelemetryContractError("Unknown telemetry metric.")
        normalized_labels = _validated_labels(labels, spec.labels)
        normalized_value = _number(value, spec)
        self._sink.emit(
            {
                "schemaVersion": 1,
                "kind": kind,
                "name": name,
                "labels": normalized_labels,
                "value": int(normalized_value)
                if normalized_value.is_integer()
                else normalized_value,
            }
        )
