from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from uuid import UUID

from flask import Request
from werkzeug.datastructures import FileStorage

from .errors import ErrorCode, PublicServiceError
from .scoring import MAX_JOB_DESCRIPTION_CODE_POINTS, MAX_RESUME_CODE_POINTS


CONSENT_VERSION = "2026-08-04.v1"
MAX_REQUEST_BYTES = 11 * 1024 * 1024
MAX_PDF_BYTES = 10 * 1024 * 1024

_ALLOWED_FORM_FIELDS = frozenset(
    {
        "resume_text",
        "source_type",
        "job_description",
        "consent_version",
        "request_id",
    }
)
_ALLOWED_FILE_FIELDS = frozenset({"resume_pdf"})
_ALLOWED_V2_FORM_FIELDS = frozenset(
    {
        "resume_text",
        "job_description",
        "consent_version",
        "request_id",
    }
)


class MemoryOnlyRequest(Request):
    """Keep multipart file parts in memory until bounded parser code sees them."""

    max_form_memory_size = MAX_REQUEST_BYTES
    max_form_parts = 32

    def _get_file_stream(
        self,
        total_content_length: int | None,
        content_type: str | None,
        filename: str | None = None,
        content_length: int | None = None,
    ) -> io.BytesIO:
        del total_content_length, content_type, filename, content_length
        return io.BytesIO()


@dataclass(frozen=True, slots=True)
class ParsedAnalysisRequest:
    request_id: UUID
    source_type: Literal["pdf", "text", "vision_text"]
    resume_text: str | None
    resume_pdf: FileStorage | None
    pdf_size: int | None
    job_description: str | None


@dataclass(frozen=True, slots=True)
class ParsedAnalysisRequestV2:
    request_id: UUID
    source_type: Literal["reviewed_text", "pdf"]
    resume_text: str | None
    resume_pdf: FileStorage | None
    pdf_size: int | None
    job_description: str | None


class RequestValidationError(PublicServiceError):
    def __init__(
        self,
        code: ErrorCode = ErrorCode.INVALID_REQUEST,
        *,
        status_code: int | None = None,
    ) -> None:
        self.status_code = status_code
        super().__init__(code, retryable=False)


def _one_form_value(request: Request, name: str, *, required: bool) -> str | None:
    values = request.form.getlist(name)
    if len(values) > 1 or required and len(values) != 1:
        raise RequestValidationError()
    if not values:
        return None
    value = values[0]
    if not isinstance(value, str) or "\x00" in value:
        raise RequestValidationError()
    return value


def _canonical_uuid(value: str) -> UUID:
    try:
        parsed = UUID(value)
    except (AttributeError, ValueError):
        raise RequestValidationError() from None
    if str(parsed) != value:
        raise RequestValidationError()
    return parsed


def _memory_stream_size(upload: FileStorage) -> int:
    if not isinstance(upload.stream, io.BytesIO):
        raise PublicServiceError(ErrorCode.SERVICE_MISCONFIGURED)
    return upload.stream.getbuffer().nbytes


def parse_analysis_request(request: Request) -> ParsedAnalysisRequest:
    """Parse and independently bound a strict v1 multipart request."""
    if request.mimetype != "multipart/form-data":
        raise RequestValidationError(status_code=415)
    if (
        request.content_length is not None
        and request.content_length > MAX_REQUEST_BYTES
    ):
        raise RequestValidationError(ErrorCode.FILE_TOO_LARGE)

    if set(request.form) - _ALLOWED_FORM_FIELDS:
        raise RequestValidationError()
    if set(request.files) - _ALLOWED_FILE_FIELDS:
        raise RequestValidationError()

    for field_name in request.form:
        if len(request.form.getlist(field_name)) != 1:
            raise RequestValidationError()
    for field_name in request.files:
        if len(request.files.getlist(field_name)) != 1:
            raise RequestValidationError()

    consent_version = _one_form_value(request, "consent_version", required=True)
    if consent_version != CONSENT_VERSION:
        raise RequestValidationError()
    request_id_text = _one_form_value(request, "request_id", required=True)
    if request_id_text is None:
        raise RequestValidationError()
    request_id = _canonical_uuid(request_id_text)

    has_resume_text = "resume_text" in request.form
    has_resume_pdf = "resume_pdf" in request.files
    if has_resume_text == has_resume_pdf:
        raise RequestValidationError()

    source_type_text = _one_form_value(request, "source_type", required=False)
    job_description = _one_form_value(
        request, "job_description", required=False
    )
    if job_description is not None:
        if len(job_description) > MAX_JOB_DESCRIPTION_CODE_POINTS:
            raise RequestValidationError(ErrorCode.SCORING_INPUT_LIMIT)
        if not job_description.strip():
            job_description = None

    if has_resume_text:
        resume_text = _one_form_value(request, "resume_text", required=True)
        if resume_text is None or not resume_text.strip():
            raise RequestValidationError()
        if len(resume_text) > MAX_RESUME_CODE_POINTS:
            raise RequestValidationError(ErrorCode.RESUME_TOO_LONG)
        if source_type_text not in {None, "text", "vision_text"}:
            raise RequestValidationError()
        source_type: Literal["text", "vision_text"] = (
            "text" if source_type_text is None else source_type_text
        )
        return ParsedAnalysisRequest(
            request_id=request_id,
            source_type=source_type,
            resume_text=resume_text,
            resume_pdf=None,
            pdf_size=None,
            job_description=job_description,
        )

    if source_type_text not in {None, "pdf"}:
        raise RequestValidationError()
    resume_pdf = request.files["resume_pdf"]
    if (
        not resume_pdf.filename
        or len(resume_pdf.filename) > 255
        or Path(resume_pdf.filename).suffix.casefold() != ".pdf"
        or resume_pdf.mimetype != "application/pdf"
    ):
        raise RequestValidationError(ErrorCode.UNSUPPORTED_FILE)
    pdf_size = _memory_stream_size(resume_pdf)
    if pdf_size > MAX_PDF_BYTES:
        raise RequestValidationError(ErrorCode.FILE_TOO_LARGE)
    return ParsedAnalysisRequest(
        request_id=request_id,
        source_type="pdf",
        resume_text=None,
        resume_pdf=resume_pdf,
        pdf_size=pdf_size,
        job_description=job_description,
    )


def parse_analysis_request_v2(
    request: Request,
    admitted_source: Literal["reviewed_text", "pdf"],
    admitted_request_id: UUID,
) -> ParsedAnalysisRequestV2:
    """Parse a strict v2 body only after header-only admission succeeds."""
    if admitted_source not in {"reviewed_text", "pdf"}:
        raise RequestValidationError()
    if not isinstance(admitted_request_id, UUID):
        raise RequestValidationError()
    if request.mimetype != "multipart/form-data":
        raise RequestValidationError(status_code=415)
    if (
        request.content_length is not None
        and request.content_length > MAX_REQUEST_BYTES
    ):
        raise RequestValidationError(ErrorCode.FILE_TOO_LARGE)
    if set(request.form) - _ALLOWED_V2_FORM_FIELDS:
        raise RequestValidationError()
    if set(request.files) - _ALLOWED_FILE_FIELDS:
        raise RequestValidationError()
    for field_name in request.form:
        if len(request.form.getlist(field_name)) != 1:
            raise RequestValidationError()
    for field_name in request.files:
        if len(request.files.getlist(field_name)) != 1:
            raise RequestValidationError()

    consent_version = _one_form_value(request, "consent_version", required=True)
    if consent_version != CONSENT_VERSION:
        raise RequestValidationError()
    request_id_text = _one_form_value(request, "request_id", required=True)
    if request_id_text is None:
        raise RequestValidationError()
    request_id = _canonical_uuid(request_id_text)
    if request_id != admitted_request_id:
        raise RequestValidationError()

    job_description = _one_form_value(
        request, "job_description", required=False
    )
    if job_description is not None:
        if len(job_description) > MAX_JOB_DESCRIPTION_CODE_POINTS:
            raise RequestValidationError(ErrorCode.SCORING_INPUT_LIMIT)
        if not job_description.strip():
            job_description = None

    has_resume_text = "resume_text" in request.form
    has_resume_pdf = "resume_pdf" in request.files
    if has_resume_text == has_resume_pdf:
        raise RequestValidationError()

    if admitted_source == "reviewed_text":
        if not has_resume_text or has_resume_pdf:
            raise RequestValidationError()
        resume_text = _one_form_value(request, "resume_text", required=True)
        if resume_text is None or not resume_text.strip():
            raise RequestValidationError()
        if len(resume_text) > MAX_RESUME_CODE_POINTS:
            raise RequestValidationError(ErrorCode.RESUME_TOO_LONG)
        return ParsedAnalysisRequestV2(
            request_id=request_id,
            source_type="reviewed_text",
            resume_text=resume_text,
            resume_pdf=None,
            pdf_size=None,
            job_description=job_description,
        )

    if not has_resume_pdf or has_resume_text:
        raise RequestValidationError()
    resume_pdf = request.files["resume_pdf"]
    if (
        not resume_pdf.filename
        or len(resume_pdf.filename) > 255
        or Path(resume_pdf.filename).suffix.casefold() != ".pdf"
        or resume_pdf.mimetype != "application/pdf"
    ):
        raise RequestValidationError(ErrorCode.UNSUPPORTED_FILE)
    pdf_size = _memory_stream_size(resume_pdf)
    if pdf_size > MAX_PDF_BYTES:
        raise RequestValidationError(ErrorCode.FILE_TOO_LARGE)
    return ParsedAnalysisRequestV2(
        request_id=request_id,
        source_type="pdf",
        resume_text=None,
        resume_pdf=resume_pdf,
        pdf_size=pdf_size,
        job_description=job_description,
    )
