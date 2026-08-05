from __future__ import annotations

import pytest

from server.config import ConfigurationError, Settings


def production_environ(**overrides: str) -> dict[str, str]:
    environ = {
        "APP_ENV": "production",
        "GROQ_API_KEY": "gsk_live_k3n4m5p6q7r8s9t0",
        "INSTALLATION_SIGNING_KEY": "a" * 32,
        "REDIS_URL": "rediss://cache.example.com:6380/0",
        "ALLOWED_WEB_ORIGINS": "https://resume.example.com",
        "PROVIDER_DEADLINE_SECONDS": "8",
        "REQUEST_DEADLINE_SECONDS": "10",
        "DEBUG": "false",
    }
    return environ | overrides


def test_production_rejects_missing_secrets():
    with pytest.raises(ConfigurationError):
        Settings.from_environ({"APP_ENV": "production"})


def test_production_rejects_hostless_redis_url():
    with pytest.raises(ConfigurationError, match="REDIS_URL"):
        Settings.from_environ(production_environ(REDIS_URL="redis://"))


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"DEBUG": "true"}, "debug"),
        ({"GROQ_API_KEY": "YOUR_API_KEY_HERE"}, "placeholder"),
        ({"INSTALLATION_SIGNING_KEY": "change-me"}, "placeholder"),
        ({"REDIS_URL": ""}, "REDIS_URL"),
        ({"ALLOWED_WEB_ORIGINS": "*"}, "wildcard"),
        ({"ALLOWED_WEB_ORIGINS": "http://resume.example.com"}, "HTTPS"),
        ({"PROVIDER_DEADLINE_SECONDS": "11"}, "provider"),
    ],
)
def test_production_rejects_unsafe_settings(overrides: dict[str, str], message: str):
    with pytest.raises(ConfigurationError, match=message):
        Settings.from_environ(production_environ(**overrides))


def test_development_settings_parse_origins_and_deadlines():
    settings = Settings.from_environ(
        {
            "APP_ENV": "development",
            "ALLOWED_WEB_ORIGINS": "http://localhost:8081, https://preview.example.com",
            "PROVIDER_DEADLINE_SECONDS": "4.5",
            "REQUEST_DEADLINE_SECONDS": "7",
        }
    )

    assert settings.app_env == "development"
    assert settings.allowed_web_origins == (
        "http://localhost:8081",
        "https://preview.example.com",
    )
    assert settings.provider_deadline_seconds == 4.5
    assert settings.request_deadline_seconds == 7.0
