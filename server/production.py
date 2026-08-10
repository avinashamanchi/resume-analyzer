from __future__ import annotations

from collections.abc import Callable
import hashlib
import hmac
from typing import TYPE_CHECKING, Any

import httpx
from groq import Groq

from .account_tokens import AccountTokenService
from .admission import AdmissionController, AdmissionRequest, RedisCapacityStore
from .ai_gateway import AiFeedbackGateway
from .apple_identity import AppleIdentityVerifier
from .config import ConfigurationError, Settings
from .entitlements import (
    AiAllowanceStore,
    NonceReplayStore,
    PlanVerificationUnavailable,
    VerifiedEntitlementCache,
)
from .installations import InstallationTokenService
from .pdf_parser import extract_pdf_text
from .rate_limit import RateLimiter, RedisRequestLeaseStore, build_redis_client
from .revenuecat import (
    EntitlementUnavailable,
    RevenueCatClient,
    RevenueCatPlanVerifier,
    RevenueCatWebhook,
)
from .scoring import score_resume

if TYPE_CHECKING:
    from .app import ServiceRegistry


_REDIS_CLIENT_OPTIONS: dict[str, object] = {
    "decode_responses": False,
    "health_check_interval": 30,
    "retry_on_timeout": False,
    "socket_connect_timeout": 2.0,
    "socket_timeout": 2.0,
}


def _runtime_key(master_key: str, purpose: bytes) -> bytes:
    return hmac.digest(
        master_key.encode("utf-8"),
        b"resume-ai-runtime:v1\0" + purpose,
        hashlib.sha256,
    )


def build_production_services(
    settings: Settings,
    *,
    redis_factory: Callable[..., Any] = build_redis_client,
    groq_factory: Callable[..., Any] = Groq,
    http_client_factory: Callable[..., httpx.Client] = httpx.Client,
) -> ServiceRegistry:
    """Build one fail-closed service registry for a production app instance."""
    settings.validate_production()
    http_client: httpx.Client | None = None
    try:
        redis_client = redis_factory(settings.redis_url, **_REDIS_CLIENT_OPTIONS)
        groq_client = groq_factory(api_key=settings.groq_api_key, max_retries=0)
        http_client = http_client_factory(follow_redirects=False)

        installation_tokens = InstallationTokenService(
            _runtime_key(settings.installation_signing_key, b"installation-token"),
            revenuecat_identity_key=_runtime_key(
                settings.installation_signing_key,
                b"revenuecat-installation-identity",
            ),
        )
        rate_limiter = RateLimiter(
            redis_client,
            key_secret=_runtime_key(
                settings.installation_signing_key,
                b"rate-limit-key",
            ),
            production=True,
        )
        leases = RedisRequestLeaseStore(
            redis_client,
            key_secret=_runtime_key(
                settings.installation_signing_key,
                b"request-lease-key",
            ),
            production=True,
        )
        entitlements = VerifiedEntitlementCache(
            redis_client,
            key_secret=_runtime_key(
                settings.installation_signing_key,
                b"plan-cache-key",
            ),
        )
        allowances = AiAllowanceStore(
            redis_client,
            key_secret=_runtime_key(
                settings.installation_signing_key,
                b"allowance-key",
            ),
        )
        revenuecat_client = RevenueCatClient(
            secret_api_key=settings.revenuecat_secret_api_key,
            http_client=http_client,
        )
        revenuecat = RevenueCatPlanVerifier(entitlements, revenuecat_client)
        replay_store = NonceReplayStore(
            redis_client,
            key_secret=_runtime_key(
                settings.installation_signing_key,
                b"apple-nonce-replay-key",
            ),
        )
        apple_identity = AppleIdentityVerifier(
            http_client=http_client,
            key_secret=_runtime_key(
                settings.installation_signing_key,
                b"apple-account-identity-key",
            ),
            replay_store=replay_store,
        )
        account_tokens = AccountTokenService(
            _runtime_key(
                settings.installation_signing_key,
                b"account-token-key",
            )
        )
        capacity = RedisCapacityStore(
            redis_client,
            key_secret=_runtime_key(
                settings.installation_signing_key,
                b"admission-capacity-key",
            ),
        )

        def reserve_allowance(request: AdmissionRequest) -> Any:
            if (
                request.revenuecat_app_user_id is None
                or request.quota_subject is None
            ):
                raise PlanVerificationUnavailable()
            try:
                plan = revenuecat.verify(
                    request.revenuecat_app_user_id,
                    deadline=2.0,
                )
                return allowances.reserve(
                    request.quota_subject,
                    plan,
                    request.request_id,
                )
            except EntitlementUnavailable:
                raise PlanVerificationUnavailable() from None

        admission = AdmissionController(
            capacity,
            allowance_reserver=reserve_allowance,
            rate_limiter=rate_limiter,
        )

        # Imported only when the factory is called to keep the module graph acyclic.
        from .app import ServiceRegistry

        return ServiceRegistry(
            pdf_parser=extract_pdf_text,
            scorer=score_resume,
            ai_gateway=AiFeedbackGateway(groq_client, settings=settings),
            installation_tokens=installation_tokens,
            rate_limiter=rate_limiter,
            leases=leases,
            admission=admission,
            account_tokens=account_tokens,
            allowances=allowances,
            entitlements=entitlements,
            revenuecat=revenuecat,
            apple_identity=apple_identity,
            revenuecat_webhook=RevenueCatWebhook(
                webhook_secret=settings.revenuecat_webhook_secret,
                webhook_signing_secret=(
                    settings.revenuecat_webhook_signing_secret
                ),
                app_id=settings.revenuecat_app_id,
            ),
        )
    except ConfigurationError:
        raise
    except Exception:
        if http_client is not None:
            try:
                http_client.close()
            except Exception:
                pass
    raise ConfigurationError("production services could not be configured")
