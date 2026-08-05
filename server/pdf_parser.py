from __future__ import annotations

import io
import math
import multiprocessing
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from multiprocessing.connection import Connection
from pathlib import Path
from typing import BinaryIO, TypeAlias

from .errors import ErrorCode, PublicServiceError


PDF_PARSE_TIMEOUT_SECONDS = 5.0
_MAX_CHILD_ADDRESS_SPACE_BYTES = 512 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class PdfLimits:
    max_bytes: int = 10 * 1024 * 1024
    max_pages: int = 10
    max_code_points: int = 30_000


@dataclass(frozen=True, slots=True)
class ParsedPdf:
    text: str
    page_count: int


@dataclass(frozen=True, slots=True)
class ExtractedResume:
    text: str
    page_count: int


WorkerTarget: TypeAlias = Callable[
    [Connection, Connection, PdfLimits, float], None
]


def _apply_child_resource_limits(timeout_seconds: float) -> None:
    if not sys.platform.startswith("linux"):
        return

    import resource

    cpu_seconds = max(1, math.ceil(timeout_seconds))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
    resource.setrlimit(
        resource.RLIMIT_AS,
        (_MAX_CHILD_ADDRESS_SPACE_BYTES, _MAX_CHILD_ADDRESS_SPACE_BYTES),
    )


def _parse_pdf_bytes(pdf_bytes: bytes, limits: PdfLimits) -> ParsedPdf:
    import pdfplumber
    from pdfminer.pdfdocument import PDFPasswordIncorrect
    from pdfminer.pdfpage import PDFPage
    from pdfplumber.page import Page

    page_text: list[str] = []
    opened_pages: list[Page] = []
    pdf_stream = io.BytesIO(pdf_bytes)
    pdf = None
    try:
        pdf = pdfplumber.open(pdf_stream)
        initial_doctop = 0
        for page_count, page_object in enumerate(
            PDFPage.create_pages(pdf.doc), start=1
        ):
            if page_count > limits.max_pages:
                raise PublicServiceError(ErrorCode.PDF_TOO_MANY_PAGES)
            page = Page(
                pdf,
                page_object,
                page_number=page_count,
                initial_doctop=initial_doctop,
            )
            opened_pages.append(page)
            extracted = (page.extract_text() or "").replace("\r\n", "\n")
            page_text.append(extracted.replace("\r", "\n"))
            initial_doctop += page.height
    except PDFPasswordIncorrect:
        raise PublicServiceError(ErrorCode.PDF_ENCRYPTED) from None
    except PublicServiceError:
        raise
    except Exception as error:
        cause: BaseException | None = error
        while cause is not None:
            if isinstance(cause, PDFPasswordIncorrect):
                raise PublicServiceError(ErrorCode.PDF_ENCRYPTED) from None
            cause = cause.__cause__ or cause.__context__
        raise PublicServiceError(ErrorCode.PDF_INVALID) from None
    finally:
        for opened_page in opened_pages:
            opened_page.close()
        if pdf is not None:
            pdf.flush_cache()
        pdf_stream.close()

    return ParsedPdf(text="\n".join(page_text), page_count=len(page_text))


def _pdf_worker_entry(
    request_pipe: Connection,
    response_pipe: Connection,
    limits: PdfLimits,
    timeout_seconds: float,
) -> None:
    pdf_bytes: bytes | None = None
    try:
        _apply_child_resource_limits(timeout_seconds)
        pdf_bytes = request_pipe.recv_bytes(limits.max_bytes + 1)
        parsed = _parse_pdf_bytes(pdf_bytes, limits)
        response_pipe.send(("ok", parsed.text, parsed.page_count))
    except PublicServiceError as error:
        response_pipe.send(("error", error.code.value))
    except BaseException:
        try:
            response_pipe.send(("error", ErrorCode.PDF_INVALID.value))
        except (BrokenPipeError, EOFError, OSError):
            pass
    finally:
        pdf_bytes = None
        request_pipe.close()
        response_pipe.close()


class IsolatedPdfWorker:
    def __init__(
        self,
        *,
        limits: PdfLimits | None = None,
        process_target: WorkerTarget = _pdf_worker_entry,
    ) -> None:
        self._limits = limits or PdfLimits()
        self._process_target = process_target

    @staticmethod
    def _stop_process(process: multiprocessing.Process) -> None:
        if not process.is_alive():
            process.join()
            return

        process.terminate()
        process.join(0.25)
        if process.is_alive():
            process.kill()
            process.join()

    def parse(self, pdf_bytes: bytes, timeout_seconds: float) -> ParsedPdf:
        if timeout_seconds <= 0 or not math.isfinite(timeout_seconds):
            raise PublicServiceError(ErrorCode.PDF_TIMEOUT)

        context = multiprocessing.get_context("spawn")
        request_receive, request_send = context.Pipe(duplex=False)
        response_receive, response_send = context.Pipe(duplex=False)
        process = context.Process(
            target=self._process_target,
            args=(request_receive, response_send, self._limits, timeout_seconds),
            daemon=True,
        )
        response: tuple[str, str, int] | tuple[str, str] | None = None
        deadline = time.monotonic() + timeout_seconds

        try:
            process.start()
            request_receive.close()
            response_send.close()
            try:
                request_send.send_bytes(pdf_bytes)
            except (BrokenPipeError, EOFError, OSError):
                self._stop_process(process)
                raise PublicServiceError(ErrorCode.PDF_INVALID) from None
            finally:
                request_send.close()

            remaining = max(0.0, deadline - time.monotonic())
            if not response_receive.poll(remaining):
                self._stop_process(process)
                raise PublicServiceError(ErrorCode.PDF_TIMEOUT)

            try:
                response = response_receive.recv()
            except (EOFError, OSError):
                self._stop_process(process)
                raise PublicServiceError(ErrorCode.PDF_INVALID) from None

            process.join(max(0.0, deadline - time.monotonic()))
            if process.is_alive():
                self._stop_process(process)
                raise PublicServiceError(ErrorCode.PDF_TIMEOUT)

            if not isinstance(response, tuple) or len(response) < 2:
                raise PublicServiceError(ErrorCode.PDF_INVALID)
            if response[0] == "error" and len(response) == 2:
                try:
                    code = ErrorCode(response[1])
                except (TypeError, ValueError):
                    code = ErrorCode.PDF_INVALID
                raise PublicServiceError(code)
            if response[0] != "ok" or len(response) != 3:
                raise PublicServiceError(ErrorCode.PDF_INVALID)

            text, page_count = response[1], response[2]
            if not isinstance(text, str) or not isinstance(page_count, int):
                raise PublicServiceError(ErrorCode.PDF_INVALID)
            return ParsedPdf(text=text, page_count=page_count)
        finally:
            if process.is_alive():
                self._stop_process(process)
            for connection in (
                request_receive,
                request_send,
                response_receive,
                response_send,
            ):
                connection.close()
            response = None
            pdf_bytes = b""


def extract_pdf_text(
    stream: BinaryIO, declared_size: int, filename: str
) -> ExtractedResume:
    limits = PdfLimits()
    pdf_bytes: bytes | None = None
    try:
        if Path(filename).suffix.lower() != ".pdf":
            raise PublicServiceError(ErrorCode.UNSUPPORTED_FILE)
        if declared_size > limits.max_bytes:
            raise PublicServiceError(ErrorCode.FILE_TOO_LARGE)

        pdf_bytes = stream.read(limits.max_bytes + 1)
        if len(pdf_bytes) > limits.max_bytes:
            raise PublicServiceError(ErrorCode.FILE_TOO_LARGE)
        if not pdf_bytes.startswith(b"%PDF-"):
            raise PublicServiceError(ErrorCode.UNSUPPORTED_FILE)

        parsed = IsolatedPdfWorker(limits=limits).parse(
            pdf_bytes, timeout_seconds=PDF_PARSE_TIMEOUT_SECONDS
        )
        normalized_text = parsed.text.replace("\r\n", "\n").replace("\r", "\n")
        if "\x00" in normalized_text:
            raise PublicServiceError(ErrorCode.PDF_INVALID)
        if len(normalized_text) > limits.max_code_points:
            raise PublicServiceError(ErrorCode.RESUME_TOO_LONG)
        if not normalized_text.strip():
            raise PublicServiceError(ErrorCode.SCAN_REQUIRED)

        return ExtractedResume(text=normalized_text, page_count=parsed.page_count)
    finally:
        pdf_bytes = None
        stream.close()
