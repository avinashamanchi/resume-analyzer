from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from flask import Flask, g, jsonify, request
from flask_cors import CORS
from werkzeug.exceptions import BadRequest, HTTPException, RequestEntityTooLarge

from .config import ConfigurationError, Settings
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


def create_app(
    settings: Settings | None = None, services: ServiceRegistry | None = None
) -> Flask:
    """Create the versioned HTTP application with injected route services."""
    configured_settings = settings or Settings.from_current_environ()
    if (
        not configured_settings.allowed_web_origins
        or any("*" in origin for origin in configured_settings.allowed_web_origins)
    ):
        raise ConfigurationError("wildcard CORS origins are forbidden")
    app = Flask(__name__)
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

    CORS(
        app,
        origins=list(configured_settings.allowed_web_origins),
        methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        expose_headers=["X-Request-ID"],
        supports_credentials=False,
        vary_header=True,
    )

    @app.before_request
    def assign_request_id() -> None:
        g.resume_ai_request_id = uuid4()

    @app.after_request
    def apply_response_policy(response: Any) -> Any:
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = _CONTENT_SECURITY_POLICY
        response.headers["X-Request-ID"] = str(g.resume_ai_request_id)
        if request.path in {"/v1/analyses", "/v1/installations"}:
            response.headers["Cache-Control"] = "no-store"
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
