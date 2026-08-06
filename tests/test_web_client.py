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
        ("/static/unicode_normalization.js", "text/javascript"),
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
    body = response.get_data(as_text=True)
    if path == "/static/support.html":
        assert body.count("https://") == 1
        assert "https://github.com/avinashamanchi/resume-analyzer/issues" in body
    else:
        assert "https://" not in body


def test_every_public_web_page_has_exact_privacy_boundaries(web_client):
    disclosures = (
        "Selected standard PDFs are transiently sent to the Resume.AI server hosted on Render for text extraction.",
        "Raw PDF bytes are never sent to Groq.",
        "Reviewed, pasted, or extracted resume text and any optional job description are sent to Groq only after consent.",
        "The app server keeps no report or content history, and this browser keeps no report history.",
        "No tracking or analytics are used.",
        "An installation security identifier and coarse pseudonymous rate-limit key are used without ads or tracking.",
        "Groq always retains usage metadata and may retain inference content for up to 30 days for reliability and abuse prevention unless Zero Data Retention is enabled; Resume.AI has not verified that setting.",
        "Render may retain provider-side connection and HTTP request metadata under its policy; Resume.AI controls only its content-free application logs.",
        "Render may process Device/IP Data and IP-based geolocation under its policy.",
        "On iOS, saved reports may be included in encrypted device or iCloud backups depending on user and iOS settings; deleting active app data does not guarantee removal from an existing backup.",
    )

    for filename in ("index.html", "privacy.html", "support.html"):
        response = web_client.get(f"/static/{filename}")
        assert response.status_code == 200
        text = response.get_data(as_text=True)
        for disclosure in disclosures:
            assert disclosure in text

    support = web_client.get("/static/support.html").get_data(as_text=True)
    assert 'href="https://github.com/avinashamanchi/resume-analyzer/issues"' in support
    assert 'rel="noreferrer"' in support
