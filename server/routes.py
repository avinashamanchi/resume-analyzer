from __future__ import annotations

import math
import time
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from flask import Blueprint, Flask, Response, current_app, g, jsonify, request
from pydantic import ValidationError
from werkzeug.exceptions import BadRequest

from .apple_identity import InvalidAppleIdentity
from .contracts import (
    AiAllowanceV2,
    AiResultV2,
    AnalysisResponseV1,
    AnalysisResponseV2,
    AppleIdentityRequestV2,
    AppleIdentityResponseV2,
    EntitlementSyncRequestV2,
    InstallationResponseV1,
    InstallationResponseV2,
    PlanSnapshotV2,
)
from .entitlements import AllowanceUnavailable, PlanVerificationUnavailable
from .errors import ErrorCode, PublicServiceError
from .installations import InstallationClaims
from .plans import AllowanceSnapshot
from .privacy import rate_limit_ip_key
from .request import (
    MAX_REQUEST_BYTES,
    ParsedAnalysisRequest,
    ParsedAnalysisRequestV2,
    RequestValidationError,
    parse_analysis_request,
    parse_analysis_request_v2,
)
from .scoring import ScoringInputError
from .revenuecat import (
    MAX_REVENUECAT_WEBHOOK_BYTES,
    EntitlementUnavailable,
    InvalidRevenueCatWebhook,
)


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


def _client_rate_limit_key() -> str:
    try:
        return rate_limit_ip_key(
            current_app.config["APP_ENV"],
            forwarded_for=request.headers.get("X-Forwarded-For"),
            socket_address=request.remote_addr,
        )
    except (TypeError, ValueError):
        raise RouteError(
            ErrorCode.SERVICE_UNAVAILABLE,
            retryable=True,
        ) from None


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
            _client_rate_limit_key()
        )
    )
    token = services.installation_tokens.issue()
    response = InstallationResponseV1(
        schemaVersion=1,
        installationToken=token,
    )
    return _json_model(response, 201)


@routes.post("/v2/installations")
def issue_installation_v2() -> tuple[Response, int]:
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
            _client_rate_limit_key()
        )
    )
    issued = services.installation_tokens.issue_v2()
    response = InstallationResponseV2(
        schemaVersion=2,
        installationToken=issued.installation_token,
        revenueCatAppUserId=issued.revenuecat_app_user_id,
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


def _resume_text_v2(parsed: ParsedAnalysisRequestV2, services: Any) -> str:
    if parsed.resume_text is not None:
        return parsed.resume_text
    upload = parsed.resume_pdf
    if upload is None or parsed.pdf_size is None or upload.filename is None:
        raise RequestValidationError()
    extracted = services.pdf_parser(upload.stream, parsed.pdf_size, upload.filename)
    return extracted.text


def _ai_allowance(snapshot: AllowanceSnapshot | None) -> AiAllowanceV2 | None:
    if snapshot is None:
        return None
    return AiAllowanceV2(
        used=snapshot.used,
        limit=snapshot.limit,
        resetsAt=snapshot.resets_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
    )


def _canonical_utc_second(value: datetime) -> str:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise RouteError(ErrorCode.SERVICE_UNAVAILABLE, retryable=True)
    # Public contracts use whole seconds; flooring is conservative for expiry.
    converted = value.astimezone(UTC).replace(microsecond=0)
    return converted.strftime("%Y-%m-%dT%H:%M:%SZ")


def _strict_json(model: Any, *, max_bytes: int) -> Any:
    if request.mimetype != "application/json":
        raise RequestValidationError(status_code=415)
    content_length = request.content_length
    if (
        isinstance(content_length, bool)
        or not isinstance(content_length, int)
        or content_length <= 0
    ):
        raise RequestValidationError()
    if content_length > max_bytes:
        raise RequestValidationError(
            ErrorCode.FILE_TOO_LARGE,
            status_code=413,
        )
    try:
        payload = request.get_json(cache=False, silent=False)
        return model.model_validate(payload)
    except (BadRequest, ValidationError, TypeError, ValueError):
        raise RequestValidationError() from None


def _authenticated_v2_identity(
    services: Any,
) -> tuple[Any, str, Any | None, str, str]:
    installation = _authorize(services)
    try:
        installation_digest = services.installation_tokens.installation_digest(
            installation
        )
        installation_app_user_id = (
            services.installation_tokens.revenuecat_app_user_id(installation)
        )
    except Exception:
        raise RouteError(ErrorCode.SERVICE_UNAVAILABLE, retryable=True) from None
    account_token = request.headers.get("X-Resume-Account")
    if account_token is None:
        return (
            installation,
            installation_digest,
            None,
            installation_app_user_id,
            installation_digest,
        )
    if services.account_tokens is None:
        raise RouteError(ErrorCode.SERVICE_UNAVAILABLE, retryable=True)
    try:
        account = services.account_tokens.verify(
            account_token,
            installation_digest,
        )
    except Exception:
        raise RouteError(ErrorCode.INVALID_INSTALLATION, status_code=401) from None
    return (
        installation,
        installation_digest,
        account,
        account.revenuecat_app_user_id,
        account.account_id,
    )


def _provider_failure_status(code: ErrorCode) -> str:
    if code is ErrorCode.AI_TIMEOUT:
        return "timeout"
    if code is ErrorCode.INVALID_AI_RESPONSE:
        return "invalid_provider_response"
    return "temporarily_unavailable"


def _v2_ai_result(
    parsed: ParsedAnalysisRequestV2,
    admission: Any,
    services: Any,
    started_at: float,
) -> AiResultV2:
    if admission.ai_status != "admitted":
        return AiResultV2(
            status=admission.ai_status,
            feedback=None,
            allowance=_ai_allowance(admission.allowance),
        )
    reservation = admission.allowance_reservation
    if reservation is None:
        return AiResultV2(
            status="plan_verification_unavailable",
            feedback=None,
            allowance=_ai_allowance(admission.allowance),
        )
    try:
        dispatch = reservation.begin_dispatch()
    except (AllowanceUnavailable, PlanVerificationUnavailable):
        return AiResultV2(
            status="plan_verification_unavailable",
            feedback=None,
            allowance=_ai_allowance(admission.allowance),
        )
    if dispatch.disposition != "started":
        status = (
            "quota_exhausted"
            if dispatch.disposition == "quota_exhausted"
            else "temporarily_unavailable"
        )
        return AiResultV2(
            status=status,
            feedback=None,
            allowance=_ai_allowance(dispatch.allowance),
        )

    charged = _ai_allowance(dispatch.allowance)
    elapsed = time.monotonic() - started_at
    remaining = current_app.config["REQUEST_DEADLINE_SECONDS"] - elapsed
    ai_deadline = min(
        current_app.config["PROVIDER_DEADLINE_SECONDS"],
        remaining,
    )
    if ai_deadline <= 0 or not math.isfinite(ai_deadline):
        return AiResultV2(status="timeout", feedback=None, allowance=charged)
    try:
        feedback = services.ai_gateway.analyze(
            parsed.resume_text if parsed.resume_text is not None else "",
            parsed.job_description,
            ai_deadline,
        )
        return AiResultV2(
            status="complete",
            feedback=feedback,
            allowance=charged,
        )
    except PublicServiceError as error:
        return AiResultV2(
            status=_provider_failure_status(error.code),
            feedback=None,
            allowance=charged,
        )
    except ValidationError:
        return AiResultV2(
            status="invalid_provider_response",
            feedback=None,
            allowance=charged,
        )
    except Exception:
        return AiResultV2(
            status="temporarily_unavailable",
            feedback=None,
            allowance=charged,
        )


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
                _client_rate_limit_key(),
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


@routes.post("/v2/analyses")
def analyze_resume_v2() -> tuple[Response, int]:
    started_at = time.monotonic()
    services = _services()
    admission = getattr(g, "resume_ai_admission", None)
    admitted_request = getattr(g, "resume_ai_admission_request", None)
    if admission is None or admitted_request is None:
        raise RouteError(ErrorCode.SERVICE_UNAVAILABLE, retryable=True)
    parsed = parse_analysis_request_v2(
        request,
        admitted_request.source,
        admitted_request.request_id,
    )
    resume_text: str | None = None
    try:
        resume_text = _resume_text_v2(parsed, services)
        score = services.scorer(resume_text, parsed.job_description)
        ai_parsed = ParsedAnalysisRequestV2(
            request_id=parsed.request_id,
            source_type=parsed.source_type,
            resume_text=resume_text,
            resume_pdf=None,
            pdf_size=None,
            job_description=parsed.job_description,
        )
        ai_result = _v2_ai_result(ai_parsed, admission, services, started_at)
        response = AnalysisResponseV2(
            schemaVersion=2,
            analysisId=str(uuid4()),
            sourceType=parsed.source_type,
            score=score,
            ai=ai_result,
        )
        return _json_model(response, 200)
    except ScoringInputError:
        raise RouteError(ErrorCode.SCORING_INPUT_LIMIT) from None
    finally:
        resume_text = None
        if parsed.resume_pdf is not None:
            parsed.resume_pdf.close()


@routes.post("/v2/entitlements/sync")
def sync_entitlements_v2() -> tuple[Response, int]:
    services = _services()
    if services.revenuecat is None or services.allowances is None:
        raise RouteError(ErrorCode.SERVICE_UNAVAILABLE, retryable=True)
    (
        _installation,
        installation_subject,
        account,
        app_user_id,
        quota_subject,
    ) = _authenticated_v2_identity(services)
    _strict_json(EntitlementSyncRequestV2, max_bytes=2_048)
    reservation = None
    try:
        plan = services.revenuecat.verify(app_user_id, deadline=2.0)
        if account is not None and plan.kind == "pro":
            services.allowances.link_quota_subjects(
                installation_subject,
                account.account_id,
            )
        reservation = services.allowances.reserve(
            quota_subject,
            plan,
            uuid4(),
        )
        allowance = reservation.snapshot()
    except (AllowanceUnavailable, EntitlementUnavailable, PlanVerificationUnavailable):
        raise RouteError(ErrorCode.SERVICE_UNAVAILABLE, retryable=True) from None
    except PublicServiceError:
        raise
    except Exception:
        raise RouteError(ErrorCode.SERVICE_UNAVAILABLE, retryable=True) from None
    finally:
        if reservation is not None:
            try:
                reservation.release()
            except Exception:
                raise RouteError(
                    ErrorCode.SERVICE_UNAVAILABLE,
                    retryable=True,
                ) from None
    response = PlanSnapshotV2(
        schemaVersion=2,
        plan=plan.kind,
        verifiedUntil=_canonical_utc_second(plan.verified_until),
        entitlementExpiresAt=(
            None
            if plan.entitlement_expires_at is None
            else _canonical_utc_second(plan.entitlement_expires_at)
        ),
        allowance=_ai_allowance(allowance),
    )
    return _json_model(response, 200)


@routes.post("/v2/identity/apple")
def link_apple_identity_v2() -> tuple[Response, int]:
    services = _services()
    if services.apple_identity is None or services.account_tokens is None:
        raise RouteError(ErrorCode.SERVICE_UNAVAILABLE, retryable=True)
    installation = _authorize(services)
    payload = _strict_json(AppleIdentityRequestV2, max_bytes=16_384)
    try:
        installation_digest = services.installation_tokens.installation_digest(
            installation
        )
        identity = services.apple_identity.verify(
            payload.identityToken,
            payload.nonce,
        )
        issued = services.account_tokens.issue(
            identity.account_id,
            installation_digest,
            identity.revenuecat_app_user_id,
        )
    except InvalidAppleIdentity:
        raise RequestValidationError() from None
    except PublicServiceError:
        raise
    except Exception:
        raise RouteError(ErrorCode.SERVICE_UNAVAILABLE, retryable=True) from None
    response = AppleIdentityResponseV2(
        schemaVersion=2,
        accountToken=issued.token,
        expiresAt=_canonical_utc_second(
            datetime.fromtimestamp(issued.expires_at, tz=UTC)
        ),
        revenueCatAppUserId=identity.revenuecat_app_user_id,
    )
    return _json_model(response, 200)


@routes.post("/v2/revenuecat/webhook")
def receive_revenuecat_webhook_v2() -> Response:
    services = _services()
    if services.revenuecat_webhook is None or services.entitlements is None:
        raise RouteError(ErrorCode.SERVICE_UNAVAILABLE, retryable=True)
    if request.mimetype != "application/json":
        raise RequestValidationError(status_code=415)
    content_length = request.content_length
    if (
        isinstance(content_length, bool)
        or not isinstance(content_length, int)
        or content_length <= 0
        or content_length > MAX_REVENUECAT_WEBHOOK_BYTES
    ):
        raise RequestValidationError(
            ErrorCode.FILE_TOO_LARGE
            if isinstance(content_length, int)
            and not isinstance(content_length, bool)
            and content_length > MAX_REVENUECAT_WEBHOOK_BYTES
            else ErrorCode.INVALID_REQUEST
        )
    body = request.get_data(cache=False, as_text=False)
    if not isinstance(body, bytes) or len(body) != content_length:
        raise RequestValidationError()
    try:
        event = services.revenuecat_webhook.decode(request.headers, body)
        services.entitlements.claim_webhook_event(
            event.event_id,
            event.effective_at,
            event.affected_app_user_ids,
        )
    except InvalidRevenueCatWebhook:
        raise RequestValidationError(status_code=401) from None
    except Exception:
        raise RouteError(ErrorCode.SERVICE_UNAVAILABLE, retryable=True) from None
    return Response(status=204)


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
