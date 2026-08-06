from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import fakeredis
import pytest

import server.app as app_module
from server.app import ServiceRegistry, create_app
from server.config import ConfigurationError, Settings
from server.production import build_production_services


def production_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "app_env": "production",
        "debug": False,
        "groq_api_key": "gsk_" + "A" * 52,
        "groq_model": "llama-3.3-70b-versatile",
        "installation_signing_key": "master-" + "x" * 64,
        "redis_url": "rediss://cache.internal:6380/0",
        "allowed_web_origins": ("https://resume-ai.onrender.com",),
        "provider_deadline_seconds": 8.0,
        "request_deadline_seconds": 10.0,
    }
    values.update(overrides)
    return Settings(**values)


class FakeGroqClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []
        self.chat = SimpleNamespace(
            completions=SimpleNamespace(create=self._create),
        )

    def _create(self, **kwargs: object) -> object:
        self.calls.append(kwargs)
        content = json.dumps(
            {
                "matchedKeywords": ["Python"],
                "missingKeywords": ["Flask"],
                "strengths": ["Uses measurable outcomes."],
                "improvements": ["Add one API reliability example."],
                "powerBullets": ["Built Python services used by 1,000 customers."],
                "summary": "Clear experience with room for role-specific detail.",
                "simulatedRecruiterComment": (
                    "Simulated AI recruiter feedback: The resume shows relevant experience."
                ),
            }
        )
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
        )


def test_importing_application_factory_does_not_construct_clients_or_touch_network():
    environment = os.environ.copy()
    environment.update(
        {
            "APP_ENV": "production",
            "GROQ_API_KEY": "gsk_" + "I" * 52,
            "INSTALLATION_SIGNING_KEY": "import-" + "x" * 64,
            "REDIS_URL": "rediss://unreachable.invalid:6380/0",
            "ALLOWED_WEB_ORIGINS": "https://resume-ai.onrender.com",
        }
    )

    result = subprocess.run(
        [sys.executable, "-c", "import server.app; print('factory-imported')"],
        cwd=Path(__file__).resolve().parent.parent,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout == "factory-imported\n"


def test_production_builder_reuses_one_client_per_process_and_separates_keys():
    redis_client = fakeredis.FakeRedis()
    groq_client = FakeGroqClient()
    redis_calls: list[tuple[str, dict[str, object]]] = []
    groq_calls: list[dict[str, object]] = []

    def redis_factory(url: str, **kwargs: object) -> object:
        redis_calls.append((url, kwargs))
        return redis_client

    def groq_factory(**kwargs: object) -> object:
        groq_calls.append(kwargs)
        return groq_client

    services = build_production_services(
        production_settings(),
        redis_factory=redis_factory,
        groq_factory=groq_factory,
    )

    assert isinstance(services, ServiceRegistry)
    assert redis_calls == [
        (
            "rediss://cache.internal:6380/0",
            {
                "decode_responses": False,
                "health_check_interval": 30,
                "retry_on_timeout": False,
                "socket_connect_timeout": 2.0,
                "socket_timeout": 2.0,
            },
        )
    ]
    assert groq_calls == [
        {"api_key": production_settings().groq_api_key, "max_retries": 0}
    ]
    assert services.rate_limiter._redis is redis_client
    assert services.leases._redis is redis_client
    assert services.ai_gateway._client is groq_client
    runtime_keys = {
        services.installation_tokens._secret,
        services.rate_limiter._key_secret,
        services.leases._key_secret,
    }
    assert len(runtime_keys) == 3
    assert all(type(key) is bytes and len(key) == 32 for key in runtime_keys)


def test_gunicorn_factory_auto_composes_once_and_reaches_health_and_analysis(
    monkeypatch: pytest.MonkeyPatch,
):
    redis_client = fakeredis.FakeRedis()
    groq_client = FakeGroqClient()
    services = build_production_services(
        production_settings(),
        redis_factory=lambda _url, **_kwargs: redis_client,
        groq_factory=lambda **_kwargs: groq_client,
    )
    builds: list[Settings] = []

    def build(configured: Settings) -> ServiceRegistry:
        builds.append(configured)
        return services

    monkeypatch.setattr(app_module, "build_production_services", build)
    app = create_app(production_settings())
    app.config["TESTING"] = True
    client = app.test_client()

    health = client.get("/healthz")
    installation = client.post("/v1/installations")
    token = installation.get_json()["installationToken"]
    analysis = client.post(
        "/v1/analyses",
        data={
            "resume_text": Path("tests/fixtures/resumes/strong.txt").read_text(),
            "consent_version": "2026-08-04.v1",
            "request_id": str(uuid4()),
        },
        content_type="multipart/form-data",
        headers={"Authorization": f"Installation {token}"},
    )

    assert health.status_code == 200
    assert health.get_json() == {"status": "ok"}
    assert installation.status_code == 201
    assert analysis.status_code == 200
    assert analysis.get_json()["feedback"]["summary"].startswith("Clear experience")
    assert builds == [production_settings()]
    assert len(groq_client.calls) == 1
    assert redis_client.keys("rai:request-lease:v1:*") == []
    assert services.leases._owned_leases.get() is None


def test_explicit_injected_services_remain_authoritative(
    monkeypatch: pytest.MonkeyPatch,
):
    injected = object()

    def forbidden(_settings: Settings) -> ServiceRegistry:
        raise AssertionError("production builder must not run")

    monkeypatch.setattr(app_module, "build_production_services", forbidden)
    app = create_app(production_settings(), services=injected)  # type: ignore[arg-type]

    assert app.extensions["resume_ai.services"] is injected


@pytest.mark.parametrize(
    "overrides",
    [
        {"groq_api_key": ""},
        {"groq_api_key": object()},
        {"groq_model": ""},
        {"installation_signing_key": "too-short"},
        {"redis_url": "redis://"},
        {"redis_url": "redis://cache.internal:not-a-port/0"},
        {"allowed_web_origins": ("http://resume-ai.onrender.com",)},
        {"provider_deadline_seconds": float("nan")},
        {"provider_deadline_seconds": 10.0},
    ],
)
def test_direct_production_settings_fail_closed_before_client_construction(
    monkeypatch: pytest.MonkeyPatch,
    overrides: dict[str, object],
):
    monkeypatch.setattr(
        app_module,
        "build_production_services",
        lambda _settings: pytest.fail("invalid settings reached client construction"),
    )

    with pytest.raises(ConfigurationError):
        create_app(production_settings(**overrides))


def test_client_construction_failure_is_content_free_and_has_no_retained_cause():
    private_url = "rediss://private-user:private-password@cache.internal:6380/0"

    def failed_redis(_url: str, **_kwargs: object) -> object:
        raise RuntimeError(private_url)

    with pytest.raises(ConfigurationError, match="production services") as caught:
        build_production_services(
            production_settings(redis_url=private_url),
            redis_factory=failed_redis,
            groq_factory=lambda **_kwargs: pytest.fail("Groq construction must not run"),
        )

    assert private_url not in str(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None


def test_malformed_private_redis_config_is_content_free_and_not_retained():
    private_url = "rediss://private-user:private-password@cache.internal:private-port/0"

    with pytest.raises(ConfigurationError) as caught:
        create_app(
            production_settings(redis_url=private_url),
            services=object(),  # type: ignore[arg-type]
        )

    assert private_url not in str(caught.value)
    assert "private-password" not in str(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None
