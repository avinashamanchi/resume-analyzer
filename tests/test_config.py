from __future__ import annotations

import pytest

from server.config import ConfigurationError, Settings


def production_environ(**overrides: str) -> dict[str, str]:
    environ = {
        "APP_ENV": "production",
        "GROQ_API_KEY": "gsk_live_k3n4m5p6q7r8s9t0",
        "GROQ_MODEL": "llama-3.3-70b-versatile",
        "INSTALLATION_SIGNING_KEY": "a" * 32,
        "REDIS_URL": "rediss://cache.example.com:6380/0",
        "ALLOWED_WEB_ORIGINS": "https://resume.example.com",
        "PROVIDER_DEADLINE_SECONDS": "8",
        "REQUEST_DEADLINE_SECONDS": "10",
        "DEBUG": "false",
        "REVENUECAT_SECRET_API_KEY": "sk_" + "r" * 40,
        "REVENUECAT_WEBHOOK_SECRET": "w" * 40,
        "REVENUECAT_WEBHOOK_SIGNING_SECRET": "s" * 40,
        "APPLE_BUNDLE_ID": "com.avinashamanchi.resumeai",
        "APPLE_TEAM_ID": "A1B2C3D4E5",
        "APPLE_JWKS_URL": "https://appleid.apple.com/auth/keys",
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
        ({"GROQ_MODEL": ""}, "GROQ_MODEL"),
        ({"GROQ_MODEL": "https://models.example.com/unsafe"}, "GROQ_MODEL"),
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


@pytest.mark.parametrize(
    "deadline_name",
    ["PROVIDER_DEADLINE_SECONDS", "REQUEST_DEADLINE_SECONDS"],
)
def test_malformed_deadline_discards_private_value_and_parse_exception(
    deadline_name: str,
):
    private_canary = "candidate-private-deadline"

    with pytest.raises(ConfigurationError) as captured:
        Settings.from_environ(production_environ(**{deadline_name: private_canary}))

    assert str(captured.value) == f"{deadline_name} must be a number"
    assert private_canary not in str(captured.value)
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None


def test_development_settings_parse_origins_and_deadlines():
    settings = Settings.from_environ(
        {
            "APP_ENV": "development",
            "GROQ_MODEL": "llama-3.3-70b-versatile",
            "ALLOWED_WEB_ORIGINS": "http://localhost:8081, https://preview.example.com",
            "PROVIDER_DEADLINE_SECONDS": "4.5",
            "REQUEST_DEADLINE_SECONDS": "7",
        }
    )

    assert settings.app_env == "development"
    assert settings.groq_model == "llama-3.3-70b-versatile"
    assert settings.allowed_web_origins == (
        "http://localhost:8081",
        "https://preview.example.com",
    )
    assert settings.provider_deadline_seconds == 4.5
    assert settings.request_deadline_seconds == 7.0
    assert settings.revenuecat_secret_api_key == ""
    assert settings.revenuecat_webhook_secret == ""
    assert settings.revenuecat_webhook_signing_secret == ""
    assert settings.apple_bundle_id == ""
    assert settings.apple_team_id == ""
    assert settings.apple_jwks_url == "https://appleid.apple.com/auth/keys"


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("REVENUECAT_SECRET_API_KEY", ""),
        ("REVENUECAT_SECRET_API_KEY", "appl_" + "p" * 40),
        ("REVENUECAT_SECRET_API_KEY", "sk_short"),
        ("REVENUECAT_WEBHOOK_SECRET", "replace-with-webhook-secret"),
        ("REVENUECAT_WEBHOOK_SECRET", "short"),
        ("REVENUECAT_WEBHOOK_SIGNING_SECRET", "replace-with-signing-secret"),
        ("REVENUECAT_WEBHOOK_SIGNING_SECRET", "short"),
        ("APPLE_BUNDLE_ID", "com.example.resumeai"),
        ("APPLE_TEAM_ID", "lowercase01"),
        ("APPLE_TEAM_ID", "TOO-SHORT"),
        ("APPLE_JWKS_URL", "https://example.com/auth/keys"),
    ],
)
def test_production_rejects_invalid_revenuecat_and_apple_values(
    name: str, value: str
):
    with pytest.raises(ConfigurationError, match=name) as caught:
        Settings.from_environ(production_environ(**{name: value}))
    if value:
        assert value not in str(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None


def test_settings_repr_redacts_all_service_secrets():
    settings = Settings.from_environ(production_environ())
    rendered = repr(settings)
    for secret_name in (
        "GROQ_API_KEY",
        "INSTALLATION_SIGNING_KEY",
        "REVENUECAT_SECRET_API_KEY",
        "REVENUECAT_WEBHOOK_SECRET",
        "REVENUECAT_WEBHOOK_SIGNING_SECRET",
    ):
        assert production_environ()[secret_name] not in rendered


@pytest.mark.parametrize("origin", ["*", "https://*.example.com"])
def test_development_rejects_wildcard_cors_because_only_first_party_origins_are_valid(
    origin: str,
):
    with pytest.raises(ConfigurationError, match="wildcard"):
        Settings.from_environ(
            {
                "APP_ENV": "development",
                "ALLOWED_WEB_ORIGINS": origin,
            }
        )


@pytest.mark.parametrize(
    "origin",
    [
        "https://(resume|evil).example.com",
        "https://resume|evil.example.com",
        "https://user:password@resume.example.com",
        "https://resume.example.com/",
        "https://resume.example.com/path",
        "https://resume.example.com?preview=true",
        "https://resume.example.com#preview",
        "https://resume_example.com",
        "https://resume.example.com:not-a-port",
    ],
)
def test_environment_rejects_noncanonical_or_regex_bearing_cors_origins(
    origin: str,
):
    with pytest.raises(ConfigurationError, match="origin|CORS"):
        Settings.from_environ(
            {
                "APP_ENV": "development",
                "ALLOWED_WEB_ORIGINS": origin,
            }
        )


def test_environment_normalizes_cors_origins_to_canonical_literal_values():
    configured = Settings.from_environ(
        {
            "APP_ENV": "development",
            "ALLOWED_WEB_ORIGINS": (
                "HTTPS://Resume.Example.COM:443,"
                "http://LOCALHOST:80,"
                "https://[2001:0db8::1]:443,"
                "https://resume.example.com"
            ),
        }
    )

    assert configured.allowed_web_origins == (
        "https://resume.example.com",
        "http://localhost",
        "https://[2001:db8::1]",
    )


@pytest.mark.parametrize(
    "host",
    [
        "999.999.999.999",
        "256.1.1.1",
        "127.1",
        "127.0.0.01",
        "1.2.3.4.5",
        "1234.5678",
    ],
)
def test_environment_rejects_malformed_or_ambiguous_dotted_numeric_hosts(
    host: str,
):
    origin = f"https://{host}"

    with pytest.raises(ConfigurationError) as caught:
        Settings.from_environ(
            {
                "APP_ENV": "development",
                "ALLOWED_WEB_ORIGINS": origin,
            }
        )

    assert origin not in str(caught.value)


def test_environment_preserves_valid_ip_literal_origins():
    configured = Settings.from_environ(
        {
            "APP_ENV": "development",
            "ALLOWED_WEB_ORIGINS": (
                "http://192.0.2.10:80,"
                "https://[2001:0db8::1]:443"
            ),
        }
    )

    assert configured.allowed_web_origins == (
        "http://192.0.2.10",
        "https://[2001:db8::1]",
    )
