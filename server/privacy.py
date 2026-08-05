from __future__ import annotations

import ipaddress
from uuid import UUID

from .contracts import PublicErrorV1
from .errors import ErrorCode


_PUBLIC_MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.INVALID_REQUEST: "The request is invalid.",
    ErrorCode.INVALID_INSTALLATION: "The installation authorization is invalid.",
    ErrorCode.RATE_LIMITED: "Too many requests. Please try again later.",
    ErrorCode.REQUEST_IN_PROGRESS: (
        "A request with this identifier is already in progress."
    ),
    ErrorCode.UNSUPPORTED_FILE: "The uploaded file is not a supported PDF.",
    ErrorCode.FILE_TOO_LARGE: "The upload is too large.",
    ErrorCode.PDF_TOO_MANY_PAGES: "The PDF has too many pages.",
    ErrorCode.PDF_ENCRYPTED: "Encrypted PDFs are not supported.",
    ErrorCode.PDF_INVALID: "The PDF could not be processed.",
    ErrorCode.PDF_TIMEOUT: "PDF processing timed out. Please try again.",
    ErrorCode.SCAN_REQUIRED: "No selectable text was found in the PDF.",
    ErrorCode.RESUME_TOO_LONG: "The submitted document text is too long.",
    ErrorCode.SCORING_INPUT_LIMIT: "The submitted text is too long.",
    ErrorCode.AI_TIMEOUT: "The feedback service timed out. Please try again.",
    ErrorCode.AI_UNAVAILABLE: (
        "The feedback service is temporarily unavailable. Please try again."
    ),
    ErrorCode.INVALID_AI_RESPONSE: "The feedback service returned an invalid result.",
    ErrorCode.SERVICE_MISCONFIGURED: "The service is unavailable.",
    ErrorCode.SERVICE_UNAVAILABLE: "The service is temporarily unavailable.",
}


_PUBLIC_STATUSES: dict[ErrorCode, int] = {
    ErrorCode.INVALID_REQUEST: 400,
    ErrorCode.INVALID_INSTALLATION: 401,
    ErrorCode.RATE_LIMITED: 429,
    ErrorCode.REQUEST_IN_PROGRESS: 409,
    ErrorCode.UNSUPPORTED_FILE: 415,
    ErrorCode.FILE_TOO_LARGE: 413,
    ErrorCode.PDF_TOO_MANY_PAGES: 422,
    ErrorCode.PDF_ENCRYPTED: 422,
    ErrorCode.PDF_INVALID: 422,
    ErrorCode.PDF_TIMEOUT: 504,
    ErrorCode.SCAN_REQUIRED: 422,
    ErrorCode.RESUME_TOO_LONG: 413,
    ErrorCode.SCORING_INPUT_LIMIT: 413,
    ErrorCode.AI_TIMEOUT: 504,
    ErrorCode.AI_UNAVAILABLE: 503,
    ErrorCode.INVALID_AI_RESPONSE: 502,
    ErrorCode.SERVICE_MISCONFIGURED: 503,
    ErrorCode.SERVICE_UNAVAILABLE: 503,
}


def public_error(
    code: ErrorCode | str,
    request_id: UUID,
    *,
    retryable: bool,
) -> PublicErrorV1:
    """Build an error using only stable, content-free public values."""
    normalized_code = ErrorCode(code)
    return PublicErrorV1(
        schemaVersion=1,
        code=normalized_code,
        message=_PUBLIC_MESSAGES[normalized_code],
        requestId=request_id,
        retryable=retryable,
    )


def public_status(code: ErrorCode | str) -> int:
    return _PUBLIC_STATUSES[ErrorCode(code)]


def coarse_ip_key(raw_address: str | None) -> str:
    """Reduce an address before it reaches the keyed rate-limit boundary."""
    if not isinstance(raw_address, str) or len(raw_address) > 64:
        return "unknown"
    try:
        address = ipaddress.ip_address(raw_address)
    except ValueError:
        return "unknown"
    prefix_length = 24 if address.version == 4 else 64
    return str(ipaddress.ip_network((address, prefix_length), strict=False))
