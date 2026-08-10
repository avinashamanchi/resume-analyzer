from __future__ import annotations

import json

import pytest

from server.telemetry import (
    ContentFreeJsonSink,
    Telemetry,
    TelemetryContractError,
)


class FakeSink:
    def __init__(self) -> None:
        self.records: list[dict[str, object]] = []

    def emit(self, record: dict[str, object]) -> None:
        self.records.append(record)

    def serialized(self) -> str:
        return json.dumps(self.records, sort_keys=True)


def test_unknown_metric_labels_values_and_identifiers_are_rejected_before_sink():
    sink = FakeSink()
    telemetry = Telemetry(sink=sink)

    with pytest.raises(TelemetryContractError):
        telemetry.counter("analysis", {"installation_id": "private"})
    with pytest.raises(TelemetryContractError):
        telemetry.counter(
            "analysis",
            {
                "source_class": "reviewed_text",
                "ai_status": "new-unbounded-value",
                "plan_class": "free",
            },
        )
    with pytest.raises(TelemetryContractError):
        telemetry.counter("private-marker", {})

    assert sink.records == []


def test_fixed_metric_vocabulary_emits_only_bounded_content_free_records():
    sink = FakeSink()
    telemetry = Telemetry(sink=sink)

    telemetry.counter(
        "analysis",
        {
            "source_class": "reviewed_text",
            "ai_status": "not_requested",
            "plan_class": "unknown",
        },
    )
    telemetry.histogram(
        "total_latency_ms",
        31.2,
        {"route": "analyses_v2", "status_class": "2xx"},
    )
    telemetry.gauge("redis_health", 1, {})

    assert [record["kind"] for record in sink.records] == [
        "counter",
        "histogram",
        "gauge",
    ]
    assert sink.records[1]["bucket"] == 50
    assert sink.records[2]["value"] == 1
    rendered = sink.serialized()
    for forbidden in (
        "installation_id",
        "resume_text",
        "job_description",
        "filename",
        "/Users/avi",
        "PRIVATE_MARKER_7f82",
    ):
        assert forbidden not in rendered


def test_json_sink_is_single_line_bounded_and_never_serializes_arbitrary_objects():
    writes: list[str] = []
    sink = ContentFreeJsonSink(writes.append)
    sink.emit(
        {
            "schemaVersion": 1,
            "kind": "counter",
            "name": "http_requests",
            "labels": {"route": "health", "status_class": "2xx"},
            "value": 1,
        }
    )

    assert len(writes) == 1
    assert writes[0].endswith("\n")
    assert "\n" not in writes[0][:-1]
    assert len(writes[0].encode("utf-8")) <= 1_024
