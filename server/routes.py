from __future__ import annotations

import math
import time
from typing import Any
from uuid import uuid4

from flask import Blueprint, Flask, Response, current_app, g, jsonify, request

from .contracts import AnalysisResponseV1, InstallationResponseV1
from .errors import ErrorCode, PublicServiceError
from .installations import InstallationClaims
from .privacy import coarse_ip_key
from .request import (
    MAX_REQUEST_BYTES,
    ParsedAnalysisRequest,
    RequestValidationError,
    parse_analysis_request,
)
from .scoring import ScoringInputError


routes = Blueprint("resume_ai_v1", __name__)


class RouteError(PublicServiceError):
    def __init__(
        self,
        code: ErrorCode,
        *,
        retryable: bool = False,
        status_code: int | None = None,
        retry_after_seconds: int | None = None,
    ) -> None:
        self.status_code = status_code
        self.retry_after_seconds = retry_after_seconds
        super().__init__(code, retryable=retryable)


def _services() -> Any:
    services = current_app.extensions.get("resume_ai.services")
    if services is None:
        raise RouteError(ErrorCode.SERVICE_UNAVAILABLE, retryable=True)
    return services


def _json_model(model: Any, status: int) -> tuple[Response, int]:
    return jsonify(model.model_dump(mode="json")), status


def _authorize(services: Any) -> InstallationClaims:
    authorization = request.headers.get("Authorization")
    if not isinstance(authorization, str):
        raise RouteError(ErrorCode.INVALID_INSTALLATION, status_code=401)
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0] != "Installation" or not parts[1]:
        raise RouteError(ErrorCode.INVALID_INSTALLATION, status_code=401)
    try:
        return services.installation_tokens.verify(parts[1])
    except PublicServiceError:
        raise
    except Exception:
        raise RouteError(ErrorCode.INVALID_INSTALLATION, status_code=401) from None


def _admit(decision: Any) -> None:
    if decision.allowed:
        return
    retry_after = decision.retry_after_seconds
    if (
        isinstance(retry_after, bool)
        or not isinstance(retry_after, int)
        or retry_after <= 0
    ):
        retry_after = 1
    raise RouteError(
        ErrorCode.RATE_LIMITED,
        retryable=True,
        retry_after_seconds=retry_after,
    )


@routes.post("/v1/installations")
def issue_installation() -> tuple[Response, int]:
    content_length = request.content_length
    if content_length is None:
        if request.stream.read(1):
            raise RequestValidationError()
    else:
        if content_length > MAX_REQUEST_BYTES:
            raise RequestValidationError(ErrorCode.FILE_TOO_LARGE)
        if content_length > 0:
            raise RequestValidationError()
    services = _services()
    _admit(
        services.rate_limiter.check_installation_issue(
            coarse_ip_key(request.remote_addr)
        )
    )
    token = services.installation_tokens.issue()
    response = InstallationResponseV1(
        schemaVersion=1,
        installationToken=token,
    )
    return _json_model(response, 201)


def _resume_text(parsed: ParsedAnalysisRequest, services: Any) -> str:
    if parsed.resume_text is not None:
        return parsed.resume_text
    upload = parsed.resume_pdf
    if upload is None or parsed.pdf_size is None or upload.filename is None:
        raise RequestValidationError()
    extracted = services.pdf_parser(upload.stream, parsed.pdf_size, upload.filename)
    return extracted.text


@routes.post("/v1/analyses")
def analyze_resume() -> tuple[Response, int]:
    started_at = time.monotonic()
    services = _services()
    claims = _authorize(services)
    parsed = parse_analysis_request(request)
    g.resume_ai_request_id = parsed.request_id
    resume_text: str | None = None
    try:
        _admit(
            services.rate_limiter.check(
                claims.installation_id,
                coarse_ip_key(request.remote_addr),
            )
        )
        lease_ttl = max(
            1,
            math.ceil(current_app.config["REQUEST_DEADLINE_SECONDS"]) + 1,
        )
        with services.leases.lease(
            claims.installation_id,
            parsed.request_id,
            lease_ttl,
        ) as acquired:
            if not acquired:
                raise RouteError(ErrorCode.REQUEST_IN_PROGRESS)
            resume_text = _resume_text(parsed, services)
            score = services.scorer(resume_text, parsed.job_description)
            elapsed = time.monotonic() - started_at
            remaining = current_app.config["REQUEST_DEADLINE_SECONDS"] - elapsed
            ai_deadline = min(
                current_app.config["PROVIDER_DEADLINE_SECONDS"],
                remaining,
            )
            if ai_deadline <= 0 or not math.isfinite(ai_deadline):
                raise RouteError(ErrorCode.AI_TIMEOUT, retryable=True)
            feedback = services.ai_gateway.analyze(
                resume_text,
                parsed.job_description,
                ai_deadline,
            )
            response = AnalysisResponseV1(
                schemaVersion=1,
                analysisId=uuid4(),
                sourceType=parsed.source_type,
                score=score,
                feedback=feedback,
            )
            return _json_model(response, 200)
    except ScoringInputError:
        raise RouteError(ErrorCode.SCORING_INPUT_LIMIT) from None
    finally:
        resume_text = None
        if parsed.resume_pdf is not None:
            parsed.resume_pdf.close()


def _healthy(service: Any) -> bool:
    check = getattr(service, "healthcheck", None)
    if not callable(check):
        return False
    try:
        return check() is True
    except Exception:
        return False


@routes.get("/healthz")
def health() -> tuple[Response, int]:
    services = _services()
    try:
        required_services = (
            services.rate_limiter,
            services.leases,
        )
        if not all(_healthy(service) for service in required_services):
            raise RouteError(ErrorCode.SERVICE_UNAVAILABLE, retryable=True)
    except PublicServiceError:
        raise
    except Exception:
        raise RouteError(ErrorCode.SERVICE_UNAVAILABLE, retryable=True) from None
    return jsonify({"status": "ok"}), 200


def register_routes(app: Flask) -> None:
    app.register_blueprint(routes)
