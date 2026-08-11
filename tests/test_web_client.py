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
    assert (STATIC / "terms.html").exists()
    assert "Groq" in html
    assert "2026-08-04.v1" in html


def test_public_legal_pages_disclose_subscription_processing_and_cancellation():
    privacy = (STATIC / "privacy.html").read_text()
    terms = (STATIC / "terms.html").read_text()

    assert "RevenueCat" in privacy
    assert "purchase history" in privacy
    assert "payment-card details" in privacy
    assert "Deleting the app or local reports does not cancel" in terms


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
    assert "Contact support" not in script


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
        ("/static/unicode_normalization.js", "text/javascript"),
        ("/static/unicode_casefold.js", "text/javascript"),
        ("/static/contract.js", "text/javascript"),
        ("/static/lifecycle.js", "text/javascript"),
        ("/static/privacy.html", "text/html"),
        ("/static/support.html", "text/html"),
        ("/static/terms.html", "text/html"),
    ],
)
def test_flask_serves_documented_first_party_web_assets(web_client, path, content_type):
    response = web_client.get(path)

    assert response.status_code == 200
    assert response.mimetype == content_type
    assert "default-src 'self'" in response.headers["Content-Security-Policy"]
    body = response.get_data(as_text=True)
    if path == "/static/support.html":
        assert body.count("https://") == 4
        assert "https://avinashamanchi.github.io/resume-analyzer/support.html" in body
        assert "https://github.com/avinashamanchi/resume-analyzer/issues" in body
        assert "https://apps.apple.com/account/subscriptions" in body
        assert "https://reportaproblem.apple.com/" in body
        assert "public project issue tracker" in body
        assert "Interactive support is not yet available" not in body
        assert "Never send or publish a resume" in body
    else:
        assert "https://" not in body


def test_public_pages_distinguish_signed_ios_from_compatibility_web(web_client):
    index = web_client.get("/static/index.html").get_data(as_text=True)
    privacy = web_client.get("/static/privacy.html").get_data(as_text=True)
    support = web_client.get("/static/support.html").get_data(as_text=True)

    assert "This compatibility web app transiently sends a selected standard PDF" in index
    assert "Raw PDF bytes never go to Groq and are not retained as report history" in index
    assert "The service and this browser keep no content or report history" in index

    for disclosure in (
        "In the signed iOS app, a PDF stays on the device",
        "The compatibility web app can transiently upload a standard PDF",
        "local reports, local resume versions, comparisons, and job notes",
        "This data does not sync to Resume.AI servers",
        "App-controlled telemetry uses fixed, content-free event categories",
        "RevenueCat processes an anonymous entitlement identity and purchase history",
        "up to 10,000 local reports",
        "up to 100 AI requests per month",
    ):
        assert disclosure in privacy

    assert "The signed iOS app extracts PDF text on-device" in support
    assert "The compatibility web app transiently uploads a selected standard PDF" in support
    assert "Local reports, local resume versions, and job notes do not sync" in support
    for page in (index, privacy, support):
        assert "Selected standard PDFs are transiently sent" not in page

    assert 'href="https://avinashamanchi.github.io/resume-analyzer/support.html"' in support
    assert 'rel="noreferrer"' in support
    assert 'href="https://github.com/avinashamanchi/resume-analyzer/issues"' in support
    assert "Never post resume or job-description content" in support
