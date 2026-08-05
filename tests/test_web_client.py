from pathlib import Path


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
