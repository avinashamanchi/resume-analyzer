from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Mapping
from urllib.parse import urlsplit


class ConfigurationError(ValueError):
    """Raised when environment settings violate the deployment safety policy."""


_GROQ_MODEL_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,119}")
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


def _parse_origins(raw_value: str) -> tuple[str, ...]:
    origins = tuple(origin.strip() for origin in raw_value.split(",") if origin.strip())
    if not origins:
        raise ConfigurationError("ALLOWED_WEB_ORIGINS must contain at least one origin")
    for origin in origins:
        if origin == "*":
            continue
        parsed = urlsplit(origin)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ConfigurationError("ALLOWED_WEB_ORIGINS must contain only origins")
    return origins


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
                environ.get("ALLOWED_WEB_ORIGINS", "http://localhost:8081")
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
        if "*" in self.allowed_web_origins:
            raise ConfigurationError("wildcard CORS origins are forbidden in production")
        if any(urlsplit(origin).scheme != "https" for origin in self.allowed_web_origins):
            raise ConfigurationError("production CORS origins must use HTTPS")
