from __future__ import annotations

from dataclasses import dataclass, replace
import json
from pathlib import Path
import sys
import time
from typing import Any
from uuid import uuid4

from flask import Flask, g, jsonify, request
from werkzeug.exceptions import BadRequest, HTTPException, RequestEntityTooLarge

from .config import ConfigurationError, Settings, canonicalize_origins
from .errors import ErrorCode, PublicServiceError
from .privacy import public_error, public_status
from .request import MAX_REQUEST_BYTES, MemoryOnlyRequest, RequestValidationError
from .routes import register_routes
from .scoring import ScoringInputError


@dataclass(frozen=True, slots=True)
class ServiceRegistry:
    """Injected route dependencies; tests never require live external services."""

    pdf_parser: Any
    scorer: Any
    ai_gateway: Any
    installation_tokens: Any
    rate_limiter: Any
    leases: Any


_CONTENT_SECURITY_POLICY = (
    "default-src 'self'; base-uri 'none'; object-src 'none'; "
    "frame-ancestors 'none'; form-action 'self'"
)
_CORS_METHODS = "GET, POST, OPTIONS"
_CORS_HEADERS = "Authorization, Content-Type"
_CORS_HEADER_NAMES = frozenset({"authorization", "content-type"})
_WEB_STATIC_DIRECTORY = Path(__file__).resolve().parent.parent / "static"
def _response_size_bucket(response: Any) -> str:
    size = response.calculate_content_length()
    if size is None:
        return "unknown"
    if size <= 16 * 1024:
        return "small"
    if size <= 256 * 1024:
        return "medium"
    return "large"


def create_app(
    settings: Settings | None = None, services: ServiceRegistry | None = None
) -> Flask:
    """Create the versioned HTTP application with injected route services."""
    configured_settings = settings or Settings.from_current_environ()
    if not isinstance(configured_settings.app_env, str):
        raise ConfigurationError(
            "APP_ENV must be development, testing, or production"
        )
    app_env = configured_settings.app_env.strip().casefold()
    if app_env not in {"development", "testing", "production"}:
        raise ConfigurationError(
            "APP_ENV must be development, testing, or production"
        )
    canonical_origins = canonicalize_origins(
        configured_settings.allowed_web_origins,
        https_only=app_env == "production",
    )
    configured_settings = replace(
        configured_settings,
        app_env=app_env,
        allowed_web_origins=canonical_origins,
    )
    allowed_origins = frozenset(canonical_origins)
    app = Flask(
        __name__,
        static_folder=str(_WEB_STATIC_DIRECTORY),
        static_url_path="/static",
    )
    app.request_class = MemoryOnlyRequest
    app.config.from_mapping(
        APP_ENV=configured_settings.app_env,
        DEBUG=configured_settings.debug,
        PROVIDER_DEADLINE_SECONDS=configured_settings.provider_deadline_seconds,
        REQUEST_DEADLINE_SECONDS=configured_settings.request_deadline_seconds,
        MAX_CONTENT_LENGTH=MAX_REQUEST_BYTES,
    )
    app.extensions["resume_ai.settings"] = configured_settings
    if services is not None:
        app.extensions["resume_ai.services"] = services

    @app.get("/")
    def web_index() -> Any:
        return app.send_static_file("index.html")

    @app.before_request
    def assign_request_id() -> None:
        g.resume_ai_request_id = uuid4()
        g.resume_ai_started_ns = time.monotonic_ns()

    @app.after_request
    def apply_response_policy(response: Any) -> Any:
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = _CONTENT_SECURITY_POLICY
        response.headers["X-Request-ID"] = str(g.resume_ai_request_id)
        if request.path in {"/v1/analyses", "/v1/installations"}:
            response.headers["Cache-Control"] = "no-store"
        request_origin = request.headers.get("Origin")
        if request_origin is not None:
            response.vary.add("Origin")
        if request_origin in allowed_origins:
            response.headers["Access-Control-Allow-Origin"] = request_origin
            response.headers["Access-Control-Expose-Headers"] = "X-Request-ID"
            if request.method == "OPTIONS":
                requested_method = request.headers.get(
                    "Access-Control-Request-Method"
                )
                if requested_method in {"GET", "POST", "OPTIONS"}:
                    response.headers["Access-Control-Allow-Methods"] = _CORS_METHODS
                requested_headers = request.headers.get(
                    "Access-Control-Request-Headers"
                )
                if requested_headers:
                    normalized_headers = {
                        header.strip().casefold()
                        for header in requested_headers.split(",")
                        if header.strip()
                    }
                    if normalized_headers <= _CORS_HEADER_NAMES:
                        response.headers["Access-Control-Allow-Headers"] = (
                            _CORS_HEADERS
                        )
        return response

    @app.after_request
    def emit_content_free_request_log(response: Any) -> Any:
        started_ns = getattr(g, "resume_ai_started_ns", time.monotonic_ns())
        elapsed_ms = max(0, (time.monotonic_ns() - started_ns) // 1_000_000)
        payload = {
            "request_id": str(g.resume_ai_request_id),
            "status_class": f"{response.status_code // 100}xx",
            "response_size_bucket": _response_size_bucket(response),
            "latency_ms": min(elapsed_ms, 60_000),
        }
        sys.stderr.write(
            json.dumps(payload, separators=(",", ":"), sort_keys=True) + "\n"
        )
        sys.stderr.flush()
        return response

    def content_free_failure(
        error: PublicServiceError,
        *,
        status_override: int | None = None,
    ) -> tuple[Any, int]:
        payload = public_error(
            error.code,
            g.resume_ai_request_id,
            retryable=error.retryable,
        )
        status = status_override or getattr(error, "status_code", None)
        response = jsonify(payload.model_dump(mode="json"))
        retry_after = getattr(error, "retry_after_seconds", None)
        if isinstance(retry_after, int) and not isinstance(retry_after, bool):
            response.headers["Retry-After"] = str(max(1, retry_after))
        return response, status or public_status(error.code)

    @app.errorhandler(PublicServiceError)
    def handle_public_service_error(error: PublicServiceError) -> tuple[Any, int]:
        return content_free_failure(error)

    @app.errorhandler(ScoringInputError)
    def handle_scoring_input_error(error: ScoringInputError) -> tuple[Any, int]:
        del error
        return content_free_failure(
            RequestValidationError(ErrorCode.SCORING_INPUT_LIMIT)
        )

    @app.errorhandler(RequestEntityTooLarge)
    def handle_request_too_large(error: RequestEntityTooLarge) -> tuple[Any, int]:
        del error
        return content_free_failure(
            RequestValidationError(ErrorCode.FILE_TOO_LARGE),
            status_override=413,
        )

    @app.errorhandler(BadRequest)
    def handle_bad_request(error: BadRequest) -> tuple[Any, int]:
        del error
        return content_free_failure(
            RequestValidationError(ErrorCode.INVALID_REQUEST),
            status_override=400,
        )

    @app.errorhandler(HTTPException)
    def handle_http_error(error: HTTPException) -> tuple[Any, int]:
        status = error.code if isinstance(error.code, int) else 400
        return content_free_failure(
            RequestValidationError(ErrorCode.INVALID_REQUEST),
            status_override=status,
        )

    @app.errorhandler(Exception)
    def handle_unexpected_error(error: Exception) -> tuple[Any, int]:
        del error
        return content_free_failure(
            PublicServiceError(ErrorCode.SERVICE_UNAVAILABLE, retryable=True),
            status_override=503,
        )

    register_routes(app)
    return app
