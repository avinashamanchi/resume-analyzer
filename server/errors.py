from __future__ import annotations

from enum import StrEnum


class ErrorCode(StrEnum):
    """Stable, content-free categories that may be exposed to API clients."""

    INVALID_REQUEST = "invalid_request"
    INVALID_INSTALLATION = "invalid_installation"
    RATE_LIMITED = "rate_limited"
    REQUEST_IN_PROGRESS = "request_in_progress"
    UNSUPPORTED_FILE = "unsupported_file"
    FILE_TOO_LARGE = "file_too_large"
    PDF_TOO_MANY_PAGES = "pdf_too_many_pages"
    PDF_ENCRYPTED = "pdf_encrypted"
    PDF_INVALID = "pdf_invalid"
    PDF_TIMEOUT = "pdf_timeout"
    SCAN_REQUIRED = "scan_required"
    RESUME_TOO_LONG = "resume_too_long"
    SCORING_INPUT_LIMIT = "scoring_input_limit"
    AI_TIMEOUT = "ai_timeout"
    AI_UNAVAILABLE = "ai_unavailable"
    INVALID_AI_RESPONSE = "invalid_ai_response"
    SERVICE_MISCONFIGURED = "service_misconfigured"
    SERVICE_UNAVAILABLE = "service_unavailable"


class PublicServiceError(Exception):
    """Content-free service failure safe to translate at the API boundary."""

    def __init__(self, code: ErrorCode | str) -> None:
        self.code = ErrorCode(code)
        super().__init__(self.code.value)
