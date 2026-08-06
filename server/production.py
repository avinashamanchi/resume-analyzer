from __future__ import annotations

from collections.abc import Callable
import hashlib
import hmac
from typing import TYPE_CHECKING, Any

from groq import Groq
from redis import Redis

from .ai_gateway import AiFeedbackGateway
from .config import ConfigurationError, Settings
from .installations import InstallationTokenService
from .pdf_parser import extract_pdf_text
from .rate_limit import RateLimiter, RedisRequestLeaseStore
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
    redis_factory: Callable[..., Any] = Redis.from_url,
    groq_factory: Callable[..., Any] = Groq,
) -> ServiceRegistry:
    """Build one fail-closed service registry for a production app instance."""
    settings.validate_production()
    try:
        redis_client = redis_factory(settings.redis_url, **_REDIS_CLIENT_OPTIONS)
        groq_client = groq_factory(api_key=settings.groq_api_key, max_retries=0)

        # Imported only when the factory is called to keep the module graph acyclic.
        from .app import ServiceRegistry

        return ServiceRegistry(
            pdf_parser=extract_pdf_text,
            scorer=score_resume,
            ai_gateway=AiFeedbackGateway(groq_client, settings=settings),
            installation_tokens=InstallationTokenService(
                _runtime_key(settings.installation_signing_key, b"installation-token")
            ),
            rate_limiter=RateLimiter(
                redis_client,
                key_secret=_runtime_key(
                    settings.installation_signing_key,
                    b"rate-limit-key",
                ),
                production=True,
            ),
            leases=RedisRequestLeaseStore(
                redis_client,
                key_secret=_runtime_key(
                    settings.installation_signing_key,
                    b"request-lease-key",
                ),
                production=True,
            ),
        )
    except ConfigurationError:
        raise
    except Exception:
        pass
    raise ConfigurationError("production services could not be configured")
