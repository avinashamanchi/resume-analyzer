from __future__ import annotations

import ipaddress
import os
import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Mapping
from urllib.parse import urlsplit


class ConfigurationError(ValueError):
    """Raised when environment settings violate the deployment safety policy."""


_GROQ_MODEL_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,119}")
_DNS_LABEL_PATTERN = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")
_DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"


def _parse_boolean(value: str, *, name: str) -> bool:
    normalized = value.strip().casefold()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ConfigurationError(f"{name} must be a boolean")


def _parse_deadline(environ: Mapping[str, str], name: str, default: float) -> float:
    raw_value = environ.get(name, str(default)).strip()
    try:
        value = float(raw_value)
    except ValueError as error:
        raise ConfigurationError(f"{name} must be a number") from error
    if value <= 0:
        raise ConfigurationError(f"{name} must be greater than zero")
    return value


def _canonical_origin(origin: str, *, https_only: bool) -> str:
    if "*" in origin:
        raise ConfigurationError("wildcard CORS origins are forbidden")
    try:
        parsed = urlsplit(origin)
        port = parsed.port
    except ValueError:
        raise ConfigurationError(
            "ALLOWED_WEB_ORIGINS must contain only canonical origins"
        ) from None

    scheme = parsed.scheme.casefold()
    if https_only and scheme == "http":
        raise ConfigurationError("production CORS origins must use HTTPS")
    allowed_schemes = {"https"} if https_only else {"http", "https"}
    if (
        parsed.scheme.casefold() not in allowed_schemes
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
        or parsed.hostname is None
        or port == 0
    ):
        raise ConfigurationError(
            "ALLOWED_WEB_ORIGINS must contain only canonical origins"
        )

    raw_host = parsed.hostname
    if "%" in raw_host:
        raise ConfigurationError(
            "ALLOWED_WEB_ORIGINS must contain only canonical origins"
        )
    try:
        address = ipaddress.ip_address(raw_host)
    except ValueError:
        host = raw_host.casefold()
        labels = host.split(".")
        if (
            len(host) > 253
            or not labels
            or any(_DNS_LABEL_PATTERN.fullmatch(label) is None for label in labels)
        ):
            raise ConfigurationError(
                "ALLOWED_WEB_ORIGINS must contain only canonical origins"
            ) from None
        canonical_host = host
    else:
        canonical_host = (
            address.compressed if address.version == 4 else f"[{address.compressed}]"
        )

    default_port = 443 if scheme == "https" else 80
    port_suffix = "" if port is None or port == default_port else f":{port}"
    return f"{scheme}://{canonical_host}{port_suffix}"


def canonicalize_origins(
    origins: Iterable[str],
    *,
    https_only: bool,
) -> tuple[str, ...]:
    """Validate and normalize exact browser origins for literal matching."""
    if isinstance(origins, (str, bytes)):
        raise ConfigurationError(
            "ALLOWED_WEB_ORIGINS must contain at least one canonical origin"
        )
    canonical: list[str] = []
    seen: set[str] = set()
    for raw_origin in origins:
        if not isinstance(raw_origin, str) or not raw_origin.strip():
            raise ConfigurationError(
                "ALLOWED_WEB_ORIGINS must contain only canonical origins"
            )
        origin = _canonical_origin(raw_origin.strip(), https_only=https_only)
        if origin not in seen:
            seen.add(origin)
            canonical.append(origin)
    if not canonical:
        raise ConfigurationError(
            "ALLOWED_WEB_ORIGINS must contain at least one canonical origin"
        )
    return tuple(canonical)


def _parse_origins(raw_value: str, *, https_only: bool) -> tuple[str, ...]:
    origins = tuple(origin.strip() for origin in raw_value.split(",") if origin.strip())
    return canonicalize_origins(origins, https_only=https_only)


def _parse_groq_model(raw_value: str) -> str:
    model = raw_value.strip()
    if not _GROQ_MODEL_PATTERN.fullmatch(model):
        raise ConfigurationError("GROQ_MODEL must be a valid provider model identifier")
    return model


def _is_placeholder(secret: str) -> bool:
    normalized = secret.strip().casefold()
    return not normalized or any(
        marker in normalized
        for marker in ("your_", "your-", "placeholder", "change-me", "example", "replace")
    )


@dataclass(frozen=True, slots=True)
class Settings:
    app_env: str
    debug: bool
    groq_api_key: str
    groq_model: str
    installation_signing_key: str
    redis_url: str
    allowed_web_origins: tuple[str, ...]
    provider_deadline_seconds: float
    request_deadline_seconds: float

    @classmethod
    def from_environ(cls, environ: Mapping[str, str]) -> Settings:
        app_env = environ.get("APP_ENV", "development").strip().casefold()
        if app_env not in {"development", "testing", "production"}:
            raise ConfigurationError("APP_ENV must be development, testing, or production")

        debug = _parse_boolean(environ.get("DEBUG", "false"), name="DEBUG")
        provider_deadline_seconds = _parse_deadline(
            environ, "PROVIDER_DEADLINE_SECONDS", 8.0
        )
        request_deadline_seconds = _parse_deadline(
            environ, "REQUEST_DEADLINE_SECONDS", 10.0
        )
        if provider_deadline_seconds >= request_deadline_seconds:
            raise ConfigurationError(
                "provider deadline must be shorter than the request deadline"
            )

        settings = cls(
            app_env=app_env,
            debug=debug,
            groq_api_key=environ.get("GROQ_API_KEY", "").strip(),
            groq_model=_parse_groq_model(
                environ.get("GROQ_MODEL", _DEFAULT_GROQ_MODEL)
            ),
            installation_signing_key=environ.get("INSTALLATION_SIGNING_KEY", "").strip(),
            redis_url=environ.get("REDIS_URL", "").strip(),
            allowed_web_origins=_parse_origins(
                environ.get("ALLOWED_WEB_ORIGINS", "http://localhost:8081"),
                https_only=app_env == "production",
            ),
            provider_deadline_seconds=provider_deadline_seconds,
            request_deadline_seconds=request_deadline_seconds,
        )
        if settings.app_env == "production":
            settings._validate_production()
        return settings

    @classmethod
    def from_current_environ(cls) -> Settings:
        return cls.from_environ(os.environ)

    def _validate_production(self) -> None:
        if self.debug:
            raise ConfigurationError("debug must be disabled in production")
        if _is_placeholder(self.groq_api_key):
            raise ConfigurationError("GROQ_API_KEY is missing or a placeholder")
        if _is_placeholder(self.installation_signing_key) or len(self.installation_signing_key) < 32:
            raise ConfigurationError(
                "INSTALLATION_SIGNING_KEY is missing, a placeholder, or too short"
            )
        if not self.redis_url:
            raise ConfigurationError("REDIS_URL is required in production")
        parsed_redis_url = urlsplit(self.redis_url)
        if (
            parsed_redis_url.scheme not in {"redis", "rediss"}
            or not parsed_redis_url.netloc
            or not parsed_redis_url.hostname
        ):
            raise ConfigurationError("REDIS_URL must use redis or rediss with a host")
        canonicalize_origins(self.allowed_web_origins, https_only=True)
