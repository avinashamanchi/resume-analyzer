from __future__ import annotations

from dataclasses import dataclass

from flask import Flask

from .config import Settings


@dataclass(frozen=True, slots=True)
class ServiceRegistry:
    """Injection seam for the concrete route services added in a later task."""


def create_app(
    settings: Settings | None = None, services: ServiceRegistry | None = None
) -> Flask:
    """Create the HTTP application without registering product routes yet."""
    configured_settings = settings or Settings.from_current_environ()
    app = Flask(__name__)
    app.config.from_mapping(
        APP_ENV=configured_settings.app_env,
        DEBUG=configured_settings.debug,
        PROVIDER_DEADLINE_SECONDS=configured_settings.provider_deadline_seconds,
        REQUEST_DEADLINE_SECONDS=configured_settings.request_deadline_seconds,
    )
    app.extensions["resume_ai.settings"] = configured_settings
    if services is not None:
        app.extensions["resume_ai.services"] = services
    return app
