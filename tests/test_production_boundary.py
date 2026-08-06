from __future__ import annotations

import json
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from server.app import create_app
from server.config import ConfigurationError, Settings


ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node") or "node"
SENSITIVE_PARTS = (
    "candidate-private-resume",
    "private-role-description",
    "private-installation-token",
    "203.0.113.97",
    "private.pdf",
)


def _run(*command: str, cwd: Path = ROOT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
    )


def _tracked_repo(tmp_path: Path, files: dict[str, str]) -> Path:
    repository = tmp_path / "fixture-repository"
    repository.mkdir()
    assert _run("git", "init", "-q", cwd=repository).returncode == 0
    for relative_path, content in files.items():
        destination = repository / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content)
    assert _run("git", "add", "--", ".", cwd=repository).returncode == 0
    return repository


def _scanner(repository: Path) -> subprocess.CompletedProcess[str]:
    return _run(
        NODE,
        str(ROOT / "scripts" / "scan-secrets.mjs"),
        "--repo",
        str(repository),
    )


def _retention_verifier(repository: Path) -> subprocess.CompletedProcess[str]:
    return _run(
        sys.executable,
        str(ROOT / "scripts" / "verify_no_sensitive_retention.py"),
        "--root",
        str(repository),
    )


def test_production_emits_one_content_free_request_log_with_exact_schema(capsys):
    settings = Settings(
        app_env="production",
        debug=False,
        groq_api_key="configured-outside-source",
        groq_model="llama-3.3-70b-versatile",
        installation_signing_key="x" * 32,
        redis_url="rediss://private-cache.invalid:6380/0",
        allowed_web_origins=("https://resume-ai.onrender.com",),
        provider_deadline_seconds=8.0,
        request_deadline_seconds=10.0,
    )
    app = create_app(settings)
    app.config["TESTING"] = True

    response = app.test_client().post(
        "/missing?resume=candidate-private-resume",
        data="private-role-description",
        headers={
            "Authorization": "Installation private-installation-token",
            "Cookie": "resume=private.pdf",
        },
        environ_overrides={"REMOTE_ADDR": "203.0.113.97"},
    )

    captured = capsys.readouterr()
    lines = captured.err.splitlines()
    assert response.status_code == 404
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert set(payload) == {
        "request_id",
        "status_class",
        "response_size_bucket",
        "latency_ms",
    }
    assert re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        payload["request_id"],
    )
    assert payload["status_class"] == "4xx"
    assert payload["response_size_bucket"] == "small"
    assert type(payload["latency_ms"]) is int
    assert 0 <= payload["latency_ms"] <= 60_000
    rendered = captured.err + captured.out
    for private_part in SENSITIVE_PARTS:
        assert private_part not in rendered


def test_procfile_uses_bounded_gunicorn_with_access_logging_disabled():
    command = (ROOT / "Procfile").read_text().strip()
    assert command.startswith("web: ")
    arguments = shlex.split(command.removeprefix("web: "))

    assert arguments[0] == "gunicorn"
    assert arguments[1] == "server.app:create_app()"
    assert arguments[arguments.index("--bind") + 1] == "0.0.0.0:$PORT"
    assert arguments[arguments.index("--workers") + 1] == "2"
    assert arguments[arguments.index("--threads") + 1] == "4"
    assert arguments[arguments.index("--timeout") + 1] == "45"
    assert arguments[arguments.index("--access-logfile") + 1] == "/dev/null"
    assert "--access-logformat" not in arguments
    assert "python" not in arguments
    assert shutil.which("gunicorn") is not None


def test_render_blueprint_is_fail_closed_and_has_private_ephemeral_key_value():
    blueprint = (ROOT / "render.yaml").read_text()

    required_fragments = (
        "runtime: python",
        "healthCheckPath: /healthz",
        "APP_ENV",
        "value: production",
        "DEBUG",
        "value: \"false\"",
        "ALLOWED_WEB_ORIGINS",
        "value: https://resume-ai.onrender.com",
        "GROQ_API_KEY",
        "sync: false",
        "INSTALLATION_SIGNING_KEY",
        "generateValue: true",
        "type: keyvalue",
        "property: connectionString",
        "ipAllowList: []",
        "generation: off",
    )
    for fragment in required_fragments:
        assert fragment in blueprint
    assert "disk:" not in blueprint
    assert "http://" not in blueprint
    assert "access-logfile -" not in blueprint


def test_environment_example_cannot_pass_production_validation():
    values: dict[str, str] = {}
    for raw_line in (ROOT / ".env.example").read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        name, value = line.split("=", maxsplit=1)
        values[name] = value
    values["APP_ENV"] = "production"

    with pytest.raises(ConfigurationError):
        Settings.from_environ(values)


def test_secret_scanner_accepts_safe_tracked_files_and_ignores_untracked_content(
    tmp_path: Path,
):
    repository = _tracked_repo(
        tmp_path,
        {"server/app.py": "DEBUG = False\nALLOWED_WEB_ORIGINS = ('https://app.invalid',)\n"},
    )
    untracked_canary = "gsk_" + "A" * 52
    (repository / "local-only.txt").write_text(untracked_canary)

    result = _scanner(repository)

    assert result.returncode == 0, result.stderr
    assert result.stdout == "Secret scan passed for 1 tracked file.\n"
    assert untracked_canary not in result.stdout + result.stderr


@pytest.mark.parametrize(
    ("relative_path", "canary"),
    [
        ("server/provider.py", "gsk_" + "A" * 52),
        ("server/provider.py", "sk-" + "A" * 48),
        ("server/provider.py", "sk-ant-api03-" + "A" * 80),
        ("server/tls.pem", "-----BEGIN PRIVATE" + " KEY-----"),
        ("render.yaml", "GROQ_API_KEY:\n  value: change-me"),
        ("server/config.py", "INSTALLATION_SIGNING_KEY = 'change-me'"),
        ("server/config.py", "ALLOWED_WEB_ORIGINS = '*'"),
        ("server/app.py", "app.run(debug=True)"),
        ("Procfile", "web: gunicorn app:app --access-logfile -"),
        ("server/app.py", "logger.info(request.headers)"),
        ("server/app.py", "logger.info(request.get_json())"),
        (".env", "GROQ_API_KEY=" + "gsk_" + "B" * 52),
    ],
)
def test_secret_scanner_rejects_unsafe_tracked_content_without_echoing_canary(
    tmp_path: Path,
    relative_path: str,
    canary: str,
):
    repository = _tracked_repo(tmp_path, {relative_path: canary + "\n"})

    result = _scanner(repository)

    assert result.returncode == 1
    assert "Secret scan failed" in result.stderr
    assert canary not in result.stdout + result.stderr


def test_secret_scanner_skips_lock_and_generated_unicode_artifacts(tmp_path: Path):
    canary = "gsk_" + "C" * 52
    repository = _tracked_repo(
        tmp_path,
        {
            "package-lock.json": json.dumps({"integrityFixture": canary}),
            "server/generated/unicode_casefold.py": f"FIXTURE = {canary!r}\n",
        },
    )

    result = _scanner(repository)

    assert result.returncode == 0, result.stderr
    assert result.stdout == "Secret scan passed for 0 tracked files.\n"
    assert canary not in result.stdout + result.stderr


def test_retention_verifier_allows_request_local_sensitive_parsing(tmp_path: Path):
    canary = "candidate-private-resume"
    repository = _tracked_repo(
        tmp_path,
        {
            "server/routes.py": (
                "def analyze(request):\n"
                "    resume_text = request.form['resume_text']\n"
                "    job_description = request.form.get('job_description')\n"
                "    return score(resume_text, job_description)\n"
            ),
            "static/app.js": (
                "const resumeText = form.elements.namedItem('resume-text').value;\n"
                "return fetch('/v1/analyses', { method: 'POST', body: resumeText });\n"
            ),
        },
    )

    result = _retention_verifier(repository)

    assert result.returncode == 0, result.stderr
    assert result.stdout == "Sensitive-retention verification passed.\n"
    assert canary not in result.stdout + result.stderr


@pytest.mark.parametrize(
    ("relative_path", "content"),
    [
        (
            "server/models.py",
            "db.execute('CREATE TABLE reports (resume_text TEXT)')",
        ),
        (
            "server/store.py",
            "redis_client.set('job_description', job_description)",
        ),
        (
            "server/app.py",
            "logger.info(request.get_json())",
        ),
        (
            "static/app.js",
            "localStorage.setItem('resume_history', resumeText)",
        ),
        (
            "static/app.js",
            "sessionStorage.setItem('resume_history', resumeText)",
        ),
        (
            "server/history.py",
            "connection = sqlite3.connect('reports.db')",
        ),
        (
            "contracts/history.schema.json",
            '{"properties":{"filename":{"type":"string"}}}',
        ),
    ],
)
def test_retention_verifier_rejects_durable_content_and_body_logging_without_echoing(
    tmp_path: Path,
    relative_path: str,
    content: str,
):
    repository = _tracked_repo(tmp_path, {relative_path: content + "\n"})

    result = _retention_verifier(repository)

    assert result.returncode == 1
    assert "Sensitive-retention verification failed" in result.stderr
    assert content not in result.stdout + result.stderr


def test_release_docs_and_ci_cover_required_unverified_boundaries():
    required_docs = (
        ROOT / "docs" / "privacy-policy.md",
        ROOT / "docs" / "support.md",
        ROOT / "docs" / "app-store" / "privacy-draft.md",
        ROOT / "docs" / "app-store" / "review-notes-draft.md",
    )
    combined = "\n".join(path.read_text() for path in required_docs)
    for disclosure in (
        "up to 30 days",
        "usage metadata",
        "7, 14, or 30 days",
        "Device/IP Data",
        "IP-based geolocation",
        "Zero Data Retention",
        "UNVERIFIED",
        "not an exact ATS",
        "no hiring guarantee",
        "not professional, legal, or employment advice",
        "https://github.com/avinashamanchi/resume-analyzer/issues",
    ):
        assert disclosure in combined

    workflow = (ROOT / ".github" / "workflows" / "verify.yml").read_text()
    for command in (
        "uv sync --frozen",
        "uv run pytest -q",
        "node --test tests/*.test.cjs",
        "node scripts/scan-secrets.mjs",
        "uv run python scripts/verify_no_sensitive_retention.py",
        "npm ci",
        "npm test -- --runInBand",
        "npm run typecheck",
        "npm run lint",
        "expo-doctor@latest",
        "expo export --platform ios",
        "npm audit --audit-level=high",
        "git diff --check",
    ):
        assert command in workflow
    assert "permissions:\n  contents: read" in workflow
    assert "22.23.2" in workflow
    assert "3.12" in workflow
    assert "--force" not in workflow
    assert "continue-on-error" not in workflow
    assert "enable-cache: false" in workflow
    assert "cache: npm" not in workflow
