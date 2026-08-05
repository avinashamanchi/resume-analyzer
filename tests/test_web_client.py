from pathlib import Path

import pytest

from server.app import create_app
from server.config import Settings

STATIC = Path("static")


def test_linkedin_and_unsafe_html_rendering_are_removed():
    html = (STATIC / "index.html").read_text()
    script = (STATIC / "app.js").read_text()

    assert "linkedin" not in (html + script).lower()
    assert ".innerHTML" not in script
    assert "insertAdjacentHTML" not in script


def test_web_has_privacy_support_and_consent_copy():
    html = (STATIC / "index.html").read_text()

    assert (STATIC / "privacy.html").exists()
    assert (STATIC / "support.html").exists()
    assert "Groq" in html
    assert "2026-08-04.v1" in html


def test_web_client_uses_first_party_versioned_contract_and_safe_dom_apis():
    html = (STATIC / "index.html").read_text()
    script = (STATIC / "app.js").read_text()

    assert 'href="/static/styles.css"' in html
    assert 'src="/static/app.js"' in html
    assert "/v1/installations" in script
    assert "/v1/analyses" in script
    assert "FormData" in script
    assert "AbortController" in script
    assert "crypto.randomUUID" in script
    assert "createElement" in script
    assert "textContent" in script
    assert "simulatedRecruiterComment" in script
    assert "readinessScore" in script


def web_settings() -> Settings:
    return Settings(
        app_env="testing",
        debug=False,
        groq_api_key="",
        groq_model="llama-3.3-70b-versatile",
        installation_signing_key="",
        redis_url="",
        allowed_web_origins=("https://resume.example.com",),
        provider_deadline_seconds=8.0,
        request_deadline_seconds=10.0,
    )


@pytest.fixture
def web_client():
    app = create_app(web_settings())
    app.config["TESTING"] = True
    return app.test_client()


@pytest.mark.parametrize(
    "path, content_type",
    [
        ("/", "text/html"),
        ("/static/styles.css", "text/css"),
        ("/static/app.js", "text/javascript"),
        ("/static/unicode_casefold.js", "text/javascript"),
        ("/static/contract.js", "text/javascript"),
        ("/static/lifecycle.js", "text/javascript"),
        ("/static/privacy.html", "text/html"),
        ("/static/support.html", "text/html"),
    ],
)
def test_flask_serves_documented_first_party_web_assets(web_client, path, content_type):
    response = web_client.get(path)

    assert response.status_code == 200
    assert response.mimetype == content_type
    assert "default-src 'self'" in response.headers["Content-Security-Policy"]
    assert "https://" not in response.get_data(as_text=True)


def test_every_public_web_page_has_exact_privacy_boundaries():
    disclosures = (
        "Resume.AI transiently processes the selected PDF and extracts text.",
        "Raw PDF bytes are never sent to Groq.",
        "Extracted resume text and any optional job description are sent to Groq only after consent.",
        "No server history is kept.",
        "No tracking or analytics are used.",
        "Only a session installation token is kept in this browser.",
    )

    for filename in ("index.html", "privacy.html", "support.html"):
        text = (STATIC / filename).read_text()
        for disclosure in disclosures:
            assert disclosure in text
