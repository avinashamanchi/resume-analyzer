from __future__ import annotations

import io
import multiprocessing
import os
import tempfile
import time
from pathlib import Path
from unittest.mock import Mock

import pytest

from server.errors import PublicServiceError
from server.pdf_parser import (
    ExtractedResume,
    IsolatedPdfWorker,
    ParsedPdf,
    PdfLimits,
    extract_pdf_text,
)


FIXTURE_ROOT = Path(__file__).parent / "fixtures"


def open_fixture(name: str):
    return (FIXTURE_ROOT / name).open("rb")


def fixture_size(name: str) -> int:
    return (FIXTURE_ROOT / "pdfs" / name).stat().st_size


class ReadTrackingStream(io.BytesIO):
    def __init__(self, value: bytes) -> None:
        super().__init__(value)
        self.read_sizes: list[int] = []

    def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        return super().read(size)


def blank_pdf(page_count: int, *, malformed_page_after: bool = False) -> bytes:
    page_ids = [3 + index * 2 for index in range(page_count)]
    kid_references = [f"{page_id} 0 R".encode() for page_id in page_ids]
    malformed_page_id = 3 + page_count * 2
    if malformed_page_after:
        kid_references.append(f"{malformed_page_id} 0 R".encode())
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        (
            b"<< /Type /Pages /Kids ["
            + b" ".join(kid_references)
            + f"] /Count {len(kid_references)} >>".encode()
        ),
    ]
    for page_id in page_ids:
        content_id = page_id + 1
        objects.extend(
            [
                (
                    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                    b"/Resources << >> /Contents "
                    + f"{content_id} 0 R >>".encode()
                ),
                b"<< /Length 0 >>\nstream\n\nendstream",
            ]
        )
    if malformed_page_after:
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Rotate /Broken /Resources << >> >>"
        )

    document = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for object_id, body in enumerate(objects, start=1):
        offsets.append(len(document))
        document.extend(f"{object_id} 0 obj\n".encode())
        document.extend(body)
        document.extend(b"\nendobj\n")
    xref_offset = len(document)
    document.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    document.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        document.extend(f"{offset:010d} 00000 n \n".encode())
    document.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode()
    )
    return bytes(document)


def crashing_worker(request_pipe, response_pipe, limits, timeout_seconds):
    os._exit(17)


def hanging_worker(request_pipe, response_pipe, limits, timeout_seconds):
    request_pipe.recv_bytes(limits.max_bytes + 1)
    while True:
        time.sleep(1)


@pytest.fixture(autouse=True)
def assert_no_child_or_temp_file_leak(tmp_path, monkeypatch):
    temp_root = tmp_path / "parser-temp"
    temp_root.mkdir()
    monkeypatch.setenv("TMPDIR", str(temp_root))
    child_pids_before = {
        child.pid for child in multiprocessing.active_children() if child.pid is not None
    }

    yield

    leaked_children = [
        child
        for child in multiprocessing.active_children()
        if child.pid is not None and child.pid not in child_pids_before
    ]
    assert leaked_children == []
    assert list(temp_root.iterdir()) == []


def test_extracts_text_without_writing_a_temp_file(tmp_path, monkeypatch):
    monkeypatch.setattr(
        tempfile,
        "NamedTemporaryFile",
        Mock(side_effect=AssertionError("disk write")),
    )
    result = extract_pdf_text(
        open_fixture("pdfs/text-resume.pdf"), 42_000, "resume.pdf"
    )
    assert "Experience" in result.text
    assert result.page_count == 2
    assert "services.\nExperience" in result.text


@pytest.mark.parametrize(
    "fixture_name,error_code",
    [
        ("scanned-resume.pdf", "scan_required"),
        ("encrypted-resume.pdf", "pdf_encrypted"),
    ],
)
def test_rejects_nonextractable_documents(fixture_name, error_code):
    with pytest.raises(PublicServiceError) as caught:
        extract_pdf_text(
            open_fixture(f"pdfs/{fixture_name}"),
            fixture_size(fixture_name),
            fixture_name,
        )
    assert caught.value.code == error_code


def test_rejects_an_eleventh_page_before_returning_text():
    pdf_bytes = blank_pdf(page_count=11)

    with pytest.raises(PublicServiceError) as caught:
        extract_pdf_text(io.BytesIO(pdf_bytes), len(pdf_bytes), "resume.pdf")

    assert caught.value.code == "pdf_too_many_pages"


def test_stops_page_tree_traversal_at_the_eleventh_page():
    pdf_bytes = blank_pdf(page_count=11, malformed_page_after=True)

    with pytest.raises(PublicServiceError) as caught:
        extract_pdf_text(io.BytesIO(pdf_bytes), len(pdf_bytes), "resume.pdf")

    assert caught.value.code == "pdf_too_many_pages"


def test_reads_only_the_byte_limit_plus_one_and_closes_the_stream():
    limits = PdfLimits()
    stream = ReadTrackingStream(b"%PDF-" + b"x" * (limits.max_bytes - 4))

    with pytest.raises(PublicServiceError) as caught:
        extract_pdf_text(stream, declared_size=1, filename="resume.pdf")

    assert caught.value.code == "file_too_large"
    assert stream.read_sizes == [limits.max_bytes + 1]
    assert stream.closed is True


@pytest.mark.parametrize(
    ("payload", "filename"),
    [
        (b"not a pdf", "resume.pdf"),
        (blank_pdf(page_count=1), "resume.txt"),
    ],
)
def test_rejects_mismatched_extension_or_signature(payload, filename):
    with pytest.raises(PublicServiceError) as caught:
        extract_pdf_text(io.BytesIO(payload), len(payload), filename)

    assert caught.value.code == "unsupported_file"


@pytest.mark.parametrize(
    ("worker_text", "error_code"),
    [
        ("A" * 30_001, "resume_too_long"),
        ("Experience\x00Education", "pdf_invalid"),
    ],
)
def test_rejects_malicious_extracted_text(monkeypatch, worker_text, error_code):
    monkeypatch.setattr(
        IsolatedPdfWorker,
        "parse",
        lambda self, pdf_bytes, timeout_seconds: ParsedPdf(worker_text, 1),
    )
    payload = blank_pdf(page_count=1)

    with pytest.raises(PublicServiceError) as caught:
        extract_pdf_text(io.BytesIO(payload), len(payload), "resume.pdf")

    assert caught.value.code == error_code


def test_normalizes_carriage_returns_before_returning(monkeypatch):
    monkeypatch.setattr(
        IsolatedPdfWorker,
        "parse",
        lambda self, pdf_bytes, timeout_seconds: ParsedPdf("One\r\nTwo\rThree", 1),
    )
    payload = blank_pdf(page_count=1)

    result = extract_pdf_text(io.BytesIO(payload), len(payload), "resume.pdf")

    assert result == ExtractedResume(text="One\nTwo\nThree", page_count=1)


def test_rejects_a_corrupt_object_table_without_exposing_content():
    payload = b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"

    with pytest.raises(PublicServiceError) as caught:
        extract_pdf_text(io.BytesIO(payload), len(payload), "private-resume.pdf")

    assert caught.value.code == "pdf_invalid"
    assert str(caught.value) == "pdf_invalid"


def test_maps_a_crashed_child_to_pdf_invalid_and_reaps_it():
    worker = IsolatedPdfWorker(process_target=crashing_worker)
    limits = PdfLimits()
    bounded_payload = b"%PDF-" + b"x" * (limits.max_bytes - 5)

    with pytest.raises(PublicServiceError) as caught:
        worker.parse(bounded_payload, timeout_seconds=1.0)

    assert caught.value.code == "pdf_invalid"


def test_terminates_and_joins_a_hung_child_at_the_deadline():
    worker = IsolatedPdfWorker(process_target=hanging_worker)
    started_at = time.monotonic()

    with pytest.raises(PublicServiceError) as caught:
        worker.parse(blank_pdf(page_count=1), timeout_seconds=0.2)

    assert caught.value.code == "pdf_timeout"
    assert time.monotonic() - started_at < 1.5
