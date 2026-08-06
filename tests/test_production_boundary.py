from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
import yaml

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


def _socket_request(port: int, payload: bytes) -> bytes:
    with socket.create_connection(("127.0.0.1", port), timeout=1) as connection:
        connection.settimeout(1)
        connection.sendall(payload)
        response = bytearray()
        while True:
            try:
                chunk = connection.recv(65_536)
            except TimeoutError:
                break
            if not chunk:
                break
            response.extend(chunk)
        return bytes(response)


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
    assert arguments[arguments.index("--log-level") + 1] == "warning"
    assert "--access-logformat" not in arguments
    assert "python" not in arguments
    assert shutil.which("gunicorn") is not None


def test_render_blueprint_is_fail_closed_and_has_private_ephemeral_key_value():
    blueprint = (ROOT / "render.yaml").read_text()
    parsed_blueprint = yaml.load(blueprint, Loader=yaml.BaseLoader)
    web_services = [
        service
        for service in parsed_blueprint["services"]
        if service["type"] == "web"
    ]
    key_values = [
        service
        for service in parsed_blueprint["services"]
        if service["type"] == "keyvalue"
    ]
    assert len(key_values) == 1
    assert len(web_services) == 1
    web_service = web_services[0]
    key_value = key_values[0]

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
    assert key_value["persistenceMode"] == "off"
    assert key_value["maxmemoryPolicy"] == "noeviction"
    assert web_service["autoDeployTrigger"] == "off"
    environment = {
        entry["key"]: entry.get("value")
        for entry in web_service["envVars"]
    }
    assert environment["GUNICORN_CMD_ARGS"] == ""


def test_render_equivalent_gunicorn_environment_cannot_preload_or_restore_access_logs():
    blueprint = yaml.safe_load((ROOT / "render.yaml").read_text())
    web_service = next(
        service for service in blueprint["services"] if service["type"] == "web"
    )
    arguments = shlex.split(web_service["startCommand"])
    arguments[arguments.index("--bind") + 1] = "127.0.0.1:8765"
    environment = os.environ.copy()
    environment["GUNICORN_CMD_ARGS"] = (
        "--preload --access-logfile - --bind=127.0.0.1:9999"
    )
    environment.update(
        {
            entry["key"]: entry["value"]
            for entry in web_service["envVars"]
            if "value" in entry
        }
    )
    environment.update(
        {
            "GROQ_API_KEY": "synthetic-runtime-key",
            "INSTALLATION_SIGNING_KEY": "x" * 64,
            "REDIS_URL": "rediss://cache.internal:6380/0",
        }
    )

    result = subprocess.run(
        [*arguments, "--print-config"],
        cwd=ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert re.search(r"^preload_app\s+= False$", result.stdout, re.MULTILINE)
    assert re.search(r"^accesslog\s+= /dev/null$", result.stdout, re.MULTILINE)
    assert re.search(r"^bind\s+= \['127.0.0.1:8765'\]$", result.stdout, re.MULTILINE)


@pytest.mark.parametrize(
    "deadline_name",
    ["PROVIDER_DEADLINE_SECONDS", "REQUEST_DEADLINE_SECONDS"],
)
def test_real_gunicorn_startup_never_echoes_malformed_deadline(
    deadline_name: str,
):
    private_canary = f"candidate-private-{deadline_name.casefold()}"
    command = shlex.split(
        (ROOT / "Procfile").read_text().strip().removeprefix("web: ")
    )
    environment = os.environ.copy()
    environment.update(
        {
            "APP_ENV": "production",
            "DEBUG": "false",
            "GROQ_API_KEY": "synthetic-runtime-key",
            "INSTALLATION_SIGNING_KEY": "x" * 64,
            "REDIS_URL": "rediss://cache.internal:6380/0",
            "ALLOWED_WEB_ORIGINS": "https://resume-ai.onrender.com",
            "PROVIDER_DEADLINE_SECONDS": "8",
            "REQUEST_DEADLINE_SECONDS": "10",
            deadline_name: private_canary,
        }
    )

    result = subprocess.run(
        [*command, "--check-config"],
        cwd=ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert private_canary not in result.stdout + result.stderr


def test_real_gunicorn_parser_logs_never_emit_raw_request_material_or_client_ip():
    command = (ROOT / "Procfile").read_text().strip().removeprefix("web: ")
    arguments = shlex.split(command)
    bind_index = arguments.index("--bind") + 1
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        port = reserved.getsockname()[1]
    arguments[bind_index] = f"127.0.0.1:{port}"
    environment = os.environ.copy()
    environment.update(
        {
            "APP_ENV": "production",
            "DEBUG": "false",
            "GROQ_API_KEY": "synthetic-runtime-key",
            "INSTALLATION_SIGNING_KEY": "x" * 64,
            "REDIS_URL": "rediss://cache.internal:6380/0",
            "ALLOWED_WEB_ORIGINS": "https://resume-ai.onrender.com",
        }
    )
    process = subprocess.Popen(
        arguments,
        cwd=ROOT,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    private_parts = (
        "private-query",
        "private-header",
        "private-cookie",
        "private-authorization",
        "private-body",
    )
    try:
        deadline = time.monotonic() + 8
        while True:
            try:
                response = _socket_request(
                    port,
                    (
                        b"GET /missing?private-query HTTP/1.1\r\n"
                        b"Host: localhost\r\n"
                        b"Authorization: private-authorization\r\n"
                        b"Cookie: private-cookie\r\n"
                        b"Connection: close\r\n\r\n"
                    ),
                )
                break
            except OSError:
                if process.poll() is not None or time.monotonic() >= deadline:
                    pytest.fail("Gunicorn did not accept the test request")
                time.sleep(0.05)
        assert b"404" in response
        _socket_request(
            port,
            b"private-body / HTTP/1.1\r\nHost: localhost\r\n\r\n",
        )
        _socket_request(
            port,
            b"GET / HTTP/1.1\r\nprivate-header value: secret\r\n\r\n",
        )
    finally:
        process.terminate()
        try:
            stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate(timeout=5)

    rendered = stdout + stderr
    for private_part in private_parts:
        assert private_part not in rendered
    assert "127.0.0.1" not in rendered
    assert "Invalid request from ip=" not in rendered
    app_records = [json.loads(line) for line in stderr.splitlines() if line.startswith("{")]
    assert any(
        set(record)
        == {"request_id", "status_class", "response_size_bucket", "latency_ms"}
        and record["status_class"] == "4xx"
        for record in app_records
    )


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
        ("config/.env.production", "APP_ENV=development"),
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


def test_secret_scanner_skips_only_exact_lock_and_generated_artifacts(tmp_path: Path):
    canary = "gsk_" + "C" * 52
    repository = _tracked_repo(
        tmp_path,
        {
            "mobile/package-lock.json": json.dumps({"integrityFixture": canary}),
            "mobile/src/domain/generated/unicode15.ts": f"export const value = {canary!r};\n",
            "static/unicode_casefold.js": f"globalThis.value = {canary!r};\n",
        },
    )

    result = _scanner(repository)

    assert result.returncode == 0, result.stderr
    assert result.stdout == "Secret scan passed for 0 tracked files.\n"
    assert canary not in result.stdout + result.stderr


def test_secret_scanner_rejects_nonallowlisted_generated_directory(tmp_path: Path):
    canary = "gsk_" + "D" * 52
    repository = _tracked_repo(
        tmp_path,
        {"server/generated/provider.py": f"VALUE = {canary!r}\n"},
    )

    result = _scanner(repository)

    assert result.returncode == 1
    assert "Secret scan failed" in result.stderr
    assert canary not in result.stdout + result.stderr


def test_secret_scanner_rejects_unsafe_multiline_gunicorn_command(tmp_path: Path):
    repository = _tracked_repo(
        tmp_path,
        {
            "render.yaml": (
                "services:\n"
                "  - type: web\n"
                "    startCommand: >-\n"
                "      gunicorn 'server.app:create_app()' --workers 2\n"
                "      --access-logfile - --error-logfile -\n"
            )
        },
    )

    result = _scanner(repository)

    assert result.returncode == 1
    assert "unsafe-gunicorn-access-log" in result.stderr


def test_secret_scanner_only_accepts_safety_flags_in_the_gunicorn_command(
    tmp_path: Path,
):
    repository = _tracked_repo(
        tmp_path,
        {
            "render.yaml": (
                "services:\n"
                "  - type: web\n"
                "    startCommand: gunicorn 'server.app:create_app()' --workers 2\n"
                "    envVars:\n"
                "      - key: DECOY_ACCESS\n"
                "        value: --access-logfile /dev/null\n"
                "      - key: DECOY_LOGGER\n"
                "        value: --logger-class server.gunicorn_logger.ContentFreeGunicornLogger\n"
            )
        },
    )

    result = _scanner(repository)

    assert result.returncode == 1
    assert "unsafe-gunicorn-access-log" in result.stderr


def test_secret_scanner_rejects_ambiguous_multiple_gunicorn_commands(
    tmp_path: Path,
):
    safe_flags = (
        "--access-logfile /dev/null --error-logfile - --log-level warning "
        "--logger-class server.gunicorn_logger.ContentFreeGunicornLogger"
    )
    repository = _tracked_repo(
        tmp_path,
        {
            "render.yaml": (
                "services:\n"
                "  - type: web\n"
                "    name: first\n"
                f"    startCommand: gunicorn app:first {safe_flags}\n"
                "  - type: web\n"
                "    name: second\n"
                "    startCommand: gunicorn app:second\n"
            )
        },
    )

    result = _scanner(repository)

    assert result.returncode == 1
    assert "unsafe-gunicorn-access-log" in result.stderr


@pytest.mark.parametrize(
    "second_command",
    (
        "/venv/bin/gunicorn app:second",
        "uv run gunicorn app:second",
    ),
)
def test_secret_scanner_counts_wrapped_or_path_gunicorn_invocations(
    tmp_path: Path,
    second_command: str,
):
    safe_flags = (
        "--access-logfile /dev/null --error-logfile - --log-level warning "
        "--logger-class server.gunicorn_logger.ContentFreeGunicornLogger"
    )
    repository = _tracked_repo(
        tmp_path,
        {
            "render.yaml": (
                "services:\n"
                "  - type: web\n"
                f"    startCommand: gunicorn app:first {safe_flags}\n"
                "  - type: web\n"
                f"    startCommand: {second_command}\n"
            )
        },
    )

    result = _scanner(repository)

    assert result.returncode == 1
    assert "unsafe-gunicorn-access-log" in result.stderr


def test_secret_scanner_rejects_two_invocations_in_one_command_scalar(
    tmp_path: Path,
):
    safe_flags = (
        "--access-logfile /dev/null --error-logfile - --log-level warning "
        "--logger-class server.gunicorn_logger.ContentFreeGunicornLogger"
    )
    repository = _tracked_repo(
        tmp_path,
        {
            "render.yaml": (
                "services:\n"
                "  - type: web\n"
                f"    startCommand: gunicorn app:first {safe_flags} && gunicorn app:second\n"
            )
        },
    )

    result = _scanner(repository)

    assert result.returncode == 1
    assert "unsafe-gunicorn-access-log" in result.stderr


def test_secret_scanner_accepts_one_folded_content_free_gunicorn_command(
    tmp_path: Path,
):
    repository = _tracked_repo(
        tmp_path,
        {
            "render.yaml": (
                "services:\n"
                "  - type: web\n"
                "    startCommand: >-\n"
                "      gunicorn 'server.app:create_app()' --workers 2\n"
                "      --access-logfile /dev/null --error-logfile - --log-level warning\n"
                "      --logger-class server.gunicorn_logger.ContentFreeGunicornLogger\n"
            )
        },
    )

    result = _scanner(repository)

    assert result.returncode == 0, result.stderr


def test_secret_scanner_accepts_a_continued_plain_render_command(tmp_path: Path):
    repository = _tracked_repo(
        tmp_path,
        {
            "render.yaml": (
                "services:\n"
                "  - type: web\n"
                "    startCommand: gunicorn 'server.app:create_app()' --workers 2\n"
                "      --access-logfile /dev/null --error-logfile - --log-level warning\n"
                "      --logger-class server.gunicorn_logger.ContentFreeGunicornLogger\n"
            )
        },
    )

    result = _scanner(repository)

    assert result.returncode == 0, result.stderr


def test_secret_scanner_accepts_one_safe_literal_block_command(tmp_path: Path):
    repository = _tracked_repo(
        tmp_path,
        {
            "render.yaml": (
                "services:\n"
                "  - type: web\n"
                "    startCommand: |-\n"
                "      gunicorn 'server.app:create_app()' --workers 2 --access-logfile /dev/null --error-logfile - --log-level warning --logger-class server.gunicorn_logger.ContentFreeGunicornLogger\n"
            )
        },
    )

    result = _scanner(repository)

    assert result.returncode == 0, result.stderr


def test_secret_scanner_rejects_unsafe_literal_gunicorn_command_blocks(tmp_path: Path):
    repository = _tracked_repo(
        tmp_path,
        {
            "render.yaml": (
                "services:\n"
                "  - type: web\n"
                "    startCommand: |\n"
                "      gunicorn 'server.app:create_app()' --workers 2\n"
                "      --access-logfile /dev/null --error-logfile - --log-level warning\n"
                "      --logger-class server.gunicorn_logger.ContentFreeGunicornLogger\n"
            )
        },
    )

    result = _scanner(repository)

    assert result.returncode == 1
    assert "unsafe-gunicorn-access-log" in result.stderr


def test_secret_scanner_rejects_second_gunicorn_on_plain_scalar_continuation(
    tmp_path: Path,
):
    safe_flags = (
        "--access-logfile /dev/null --error-logfile - --log-level warning "
        "--logger-class server.gunicorn_logger.ContentFreeGunicornLogger"
    )
    repository = _tracked_repo(
        tmp_path,
        {
            "render.yaml": (
                "services:\n"
                "  - type: web\n"
                f"    startCommand: gunicorn app:first {safe_flags}\n"
                "      && gunicorn app:second\n"
            )
        },
    )

    result = _scanner(repository)

    assert result.returncode == 1
    assert "unsafe-gunicorn-access-log" in result.stderr


def test_secret_scanner_ignores_gunicorn_decoys_outside_start_command(
    tmp_path: Path,
):
    safe_flags = (
        "--access-logfile /dev/null --error-logfile - --log-level warning "
        "--logger-class server.gunicorn_logger.ContentFreeGunicornLogger"
    )
    repository = _tracked_repo(
        tmp_path,
        {
            "render.yaml": (
                "services:\n"
                "  - type: web\n"
                f"    startCommand: gunicorn app:first {safe_flags}\n"
                "    envVars:\n"
                "      - key: DECOY_COMMAND\n"
                "        value: gunicorn app:unsafe --access-logfile -\n"
            )
        },
    )

    result = _scanner(repository)

    assert result.returncode == 0, result.stderr


def test_secret_scanner_fails_closed_on_invalid_render_yaml_without_echoing(
    tmp_path: Path,
):
    canary = "private-yaml-parser-canary"
    repository = _tracked_repo(
        tmp_path,
        {
            "render.yaml": (
                "services:\n"
                "  - type: web\n"
                "    startCommand: [gunicorn app:app\n"
                f"    privateValue: {canary}\n"
            )
        },
    )

    result = _scanner(repository)

    assert result.returncode == 1
    assert "render-yaml-parse-failed" in result.stderr
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


def test_retention_verifier_allows_expiring_rate_limit_metadata(tmp_path: Path):
    repository = _tracked_repo(
        tmp_path,
        {
            "server/rate_limit.py": (
                "def increment(redis_client, digest):\n"
                "    return redis_client.set('rate:' + digest, 1, ex=60)\n"
            )
        },
    )

    result = _retention_verifier(repository)

    assert result.returncode == 0, result.stderr


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


@pytest.mark.parametrize(
    ("relative_path", "content"),
    [
        (
            "server/app.py",
            "payload = request.get_json()\nalias = payload\nlogger.info(\n    alias\n)",
        ),
        (
            "app.py",
            "body = request.data\nforwarded = body\nlogging.warning(\n    forwarded\n)",
        ),
        (
            "server/store.py",
            "body = request.data\nalias = body\nredis_client.set(\n    'report',\n    alias,\n)",
        ),
        (
            "server/store.py",
            "resume_text = request.form['resume_text']\nout = open('reports.txt', 'w')\nout.write(\n    resume_text\n)",
        ),
        (
            "app.py",
            "import sqlite3\nconnection = sqlite3.connect(\n    'reports.db'\n)",
        ),
        (
            "server/store.py",
            "from pathlib import Path\nPath('reports.json').write_text(\n    'safe-looking metadata'\n)",
        ),
        (
            "server/store.py",
            "from pathlib import Path\nout = Path('reports.json').open(\n    'w'\n)\nout.close()",
        ),
        (
            "server/store.py",
            "candidate = request.data\ndef retain_from_closure():\n    logger.info(candidate)",
        ),
        (
            "server/store.py",
            "req = request\nbody = req.get_json()\nlog(body)",
        ),
        (
            "server/store.py",
            "from flask import request as incoming\nbody = incoming.get_json()\nlogger.info(body)",
        ),
        (
            "server/store.py",
            "import flask as f\nvalue = f.request.get_json()\nlogger.info(value)",
        ),
        (
            "server/store.py",
            "import flask as f\nincoming = f.request\nvalue = incoming.get_json()\nlogger.info(value)",
        ),
        (
            "server/store.py",
            "class Holder:\n    pass\nholder = Holder()\nholder.value = request.get_json()\nlogger.info(holder.value)",
        ),
        (
            "server/store.py",
            "bucket = {}\nbucket['entry'] = request.data\nlogger.info(bucket['entry'])",
        ),
        (
            "server/store.py",
            "def read_request():\n    return request.get_json()\nvalue = read_request()\nlogger.info(value)",
        ),
        (
            "app.py",
            "import flask as f\ndef read_request():\n    return f.request.get_json()\ndef retain():\n    value = read_request()\n    def emit():\n        logger.info(value)\n    emit()",
        ),
    ],
)
def test_retention_verifier_tracks_multiline_aliases_into_prohibited_sinks(
    tmp_path: Path,
    relative_path: str,
    content: str,
):
    repository = _tracked_repo(tmp_path, {relative_path: content + "\n"})

    result = _retention_verifier(repository)

    assert result.returncode == 1
    assert "Sensitive-retention verification failed" in result.stderr
    assert content not in result.stdout + result.stderr


@pytest.mark.parametrize(
    ("relative_path", "content"),
    [
        (
            "server/helper_json.py",
            "def active_request():\n"
            "    return request\n"
            "body = active_request().get_json()\n"
            "logger.info(body)",
        ),
        (
            "server/helper_data.py",
            "import flask\n"
            "def active_request():\n"
            "    return flask.request\n"
            "body = active_request().data\n"
            "redis_client.set('report', body)",
        ),
        (
            "server/helper_form.py",
            "from flask import request as incoming\n"
            "def active_request():\n"
            "    return incoming\n"
            "body = active_request().form\n"
            "database.execute('INSERT INTO reports VALUES (?)', body)",
        ),
        (
            "server/helper_files.py",
            "def active_request():\n"
            "    alias = request\n"
            "    return alias\n"
            "uploads = active_request().files\n"
            "logging.warning(uploads)",
        ),
        (
            "server/attribute_alias.py",
            "class Holder:\n"
            "    pass\n"
            "holder = Holder()\n"
            "holder.active = request\n"
            "uploads = holder.active.files\n"
            "db.execute('INSERT INTO reports VALUES (?)', uploads)",
        ),
        (
            "server/subscript_alias.py",
            "bucket = {}\n"
            "bucket['active'] = request\n"
            "body = bucket['active'].get_json()\n"
            "logger.info(body)",
        ),
        (
            "server/dict_alias.py",
            "bucket = {'active': request}\n"
            "body = bucket['active'].data\n"
            "redis_client.hset('reports', 'body', body)",
        ),
        (
            "server/list_alias.py",
            "import flask as f\n"
            "requests = [f.request]\n"
            "body = requests[0].form\n"
            "logger.error(body)",
        ),
        (
            "server/fixed_point_helper.py",
            "def outer_request():\n"
            "    return inner_request()\n"
            "def inner_request():\n"
            "    return request\n"
            "body = outer_request().data\n"
            "logger.info(body)",
        ),
        (
            "server/aggregate_log.py",
            "class Holder:\n"
            "    pass\n"
            "holder = Holder()\n"
            "holder.body = request.data\n"
            "logger.info(holder)",
        ),
        (
            "server/appended_request_alias.py",
            "items = []\n"
            "items.append(request)\n"
            "body = items[0].data\n"
            "logger.info(body)",
        ),
        (
            "server/logged_ephemeral_buffer.py",
            "import io\n"
            "output = io.BytesIO()\n"
            "output.write(request.data)\n"
            "logger.info(output.getvalue())",
        ),
        (
            "server/dict_get_alias.py",
            "bucket = {'active': request}\n"
            "uploads = bucket.get('active').files\n"
            "log(uploads)",
        ),
        (
            "server/stderr_log.py",
            "import sys\n"
            "body = request.data\n"
            "sys.stderr.write(body)",
        ),
    ],
)
def test_retention_verifier_tracks_request_objects_through_helpers_and_containers(
    tmp_path: Path,
    relative_path: str,
    content: str,
):
    repository = _tracked_repo(tmp_path, {relative_path: content + "\n"})

    result = _retention_verifier(repository)

    assert result.returncode == 1
    assert "Sensitive-retention verification failed" in result.stderr
    assert content not in result.stdout + result.stderr


@pytest.mark.parametrize(
    ("relative_path", "content"),
    [
        (
            "server/attribute_sibling.py",
            "class Holder:\n"
            "    pass\n"
            "holder = Holder()\n"
            "holder.body = request.data\n"
            "holder.status = 'ready'\n"
            "logger.info(holder.status)",
        ),
        (
            "server/subscript_sibling.py",
            "holder = {}\n"
            "holder['body'] = request.get_json()\n"
            "holder['status'] = 'ready'\n"
            "logger.info(holder['status'])",
        ),
        (
            "server/ephemeral_buffers.py",
            "import io\n"
            "def parse(request):\n"
            "    chunks = []\n"
            "    chunks.append(request.data)\n"
            "    buffered = bytearray()\n"
            "    buffered.extend(request.data)\n"
            "    buffered.append(request.data[0])\n"
            "    output = io.BytesIO()\n"
            "    output.write(request.data)\n"
            "    return chunks, bytes(buffered), output.getvalue()",
        ),
        (
            "server/current_parser_shapes.py",
            "import io\n"
            "def parse(request, stream):\n"
            "    values = request.form.getlist('resume_text')\n"
            "    opened_pages = []\n"
            "    opened_pages.append(values[0])\n"
            "    page_text = []\n"
            "    page_text.append(values[0].strip())\n"
            "    buffered = bytearray()\n"
            "    chunk = stream.read(1024)\n"
            "    buffered.extend(chunk)\n"
            "    pdf_stream = io.BytesIO(bytes(buffered))\n"
            "    pdf_stream.write(request.data)\n"
            "    return opened_pages, page_text, pdf_stream.getvalue()",
        ),
        (
            "server/local_queue.py",
            "import queue\n"
            "def parse(request):\n"
            "    work_queue = queue.SimpleQueue()\n"
            "    work_queue.put(request.data)\n"
            "    return work_queue.get()",
        ),
        (
            "server/dict_get_sibling.py",
            "holder = {}\n"
            "holder['body'] = request.data\n"
            "holder['status'] = 'ready'\n"
            "logger.info(holder.get('status'))",
        ),
        (
            "server/local_list_named_redis.py",
            "redis_chunks = []\n"
            "redis_chunks.append(request.data)\n"
            "return_value = len(redis_chunks)",
        ),
        (
            "server/local_list_named_database.py",
            "database_values = []\n"
            "database_values.insert(0, request.data)\n"
            "return_value = len(database_values)",
        ),
        (
            "server/local_queue_named_database.py",
            "import queue\n"
            "database_queue = queue.SimpleQueue()\n"
            "database_queue.put(request.data)\n"
            "return_value = database_queue.qsize()",
        ),
        (
            "server/local_bytearray_named_redis.py",
            "redis_bytes = bytearray()\n"
            "redis_bytes.append(request.data[0])\n"
            "return_value = bytes(redis_bytes)",
        ),
    ],
)
def test_retention_verifier_allows_precise_siblings_and_ephemeral_accumulators(
    tmp_path: Path,
    relative_path: str,
    content: str,
):
    repository = _tracked_repo(tmp_path, {relative_path: content + "\n"})

    result = _retention_verifier(repository)

    assert result.returncode == 0, result.stderr
    assert result.stdout == "Sensitive-retention verification passed.\n"
    assert content not in result.stdout + result.stderr


@pytest.mark.parametrize(
    ("relative_path", "content"),
    [
        (
            "server/redis_store.py",
            "body = request.data\n"
            "cache = redis_client\n"
            "cache.set('report', body)",
        ),
        (
            "server/database_store.py",
            "body = request.form\n"
            "database.execute('INSERT INTO reports VALUES (?)', body)",
        ),
        (
            "server/file_store.py",
            "body = request.data\n"
            "with open('report.bin', 'wb') as output:\n"
            "    output.write(body)",
        ),
        (
            "server/path_store.py",
            "from pathlib import Path\n"
            "body = request.data\n"
            "Path('report.bin').write_bytes(body)",
        ),
        (
            "server/shelve_store.py",
            "import shelve\n"
            "body = request.get_json()\n"
            "store = shelve.open('reports')\n"
            "store['body'] = body",
        ),
        (
            "server/aliased_file_store.py",
            "body = request.data\n"
            "with open('report.bin', 'wb') as output:\n"
            "    persist = output.write\n"
            "    persist(body)",
        ),
        (
            "server/aliased_path_store.py",
            "from pathlib import Path as OutputPath\n"
            "body = request.data\n"
            "OutputPath('report.bin').write_bytes(body)",
        ),
        (
            "server/aliased_database_store.py",
            "body = request.form\n"
            "persist = database.execute\n"
            "persist('INSERT INTO reports VALUES (?)', body)",
        ),
        (
            "server/io_file_store.py",
            "import io\n"
            "body = request.data\n"
            "output = io.open('report.bin', 'wb')\n"
            "output.write(body)",
        ),
    ],
)
def test_retention_verifier_rejects_known_durable_receivers(
    tmp_path: Path,
    relative_path: str,
    content: str,
):
    repository = _tracked_repo(tmp_path, {relative_path: content + "\n"})

    result = _retention_verifier(repository)

    assert result.returncode == 1
    assert "Sensitive-retention verification failed" in result.stderr
    assert content not in result.stdout + result.stderr


@pytest.mark.parametrize(
    ("relative_path", "content"),
    [
        (
            "server/aliased_stderr.py",
            "import sys\n"
            "out = sys.stderr\n"
            "out.write(request.data)",
        ),
        (
            "server/aliased_stdout.py",
            "import sys\n"
            "out = sys.stdout\n"
            "forwarded = out\n"
            "forwarded.write(request.form)",
        ),
        (
            "server/aliased_io_open.py",
            "import io\n"
            "open_file = io.open\n"
            "factory = open_file\n"
            "factory('report.bin', 'wb').write(request.data)",
        ),
        (
            "server/aliased_builtin_open.py",
            "open_file = open\n"
            "output = open_file('report.bin', 'wb')\n"
            "output.write(request.data)",
        ),
        (
            "server/aliased_path_text.py",
            "from pathlib import Path\n"
            "OutputPath = Path\n"
            "OutputPath('report.txt').write_text(request.data.decode())",
        ),
        (
            "server/aliased_path_bytes.py",
            "from pathlib import Path\n"
            "OutputPath = Path\n"
            "ForwardPath = OutputPath\n"
            "ForwardPath('report.bin').write_bytes(request.data)",
        ),
        (
            "server/aliased_shelve.py",
            "from shelve import open as shelf_open\n"
            "open_store = shelf_open\n"
            "factory = open_store\n"
            "store = factory('reports')\n"
            "store['body'] = request.get_json()",
        ),
    ],
)
def test_retention_verifier_rejects_aliased_output_and_store_factories(
    tmp_path: Path,
    relative_path: str,
    content: str,
):
    repository = _tracked_repo(tmp_path, {relative_path: content + "\n"})

    result = _retention_verifier(repository)

    assert result.returncode == 1
    assert "Sensitive-retention verification failed" in result.stderr
    assert content not in result.stdout + result.stderr


@pytest.mark.parametrize(
    ("relative_path", "content"),
    [
        (
            "server/aliased_bytes_writer.py",
            "import io\n"
            "stream = io.BytesIO()\n"
            "write = stream.write\n"
            "write(request.data)\n"
            "value = stream.getvalue()",
        ),
        (
            "server/aliased_text_writer.py",
            "import io\n"
            "stream = io.StringIO()\n"
            "write = stream.write\n"
            "write(request.form.get('resume_text'))\n"
            "value = stream.getvalue()",
        ),
        (
            "server/aliased_bytes_factory.py",
            "import io\n"
            "stream_factory = io.BytesIO\n"
            "factory = stream_factory\n"
            "stream = factory()\n"
            "stream.write(request.data)",
        ),
        (
            "server/local_open_file.py",
            "import io\n"
            "def open_file(*_args):\n"
            "    return io.BytesIO()\n"
            "output = open_file('report.bin', 'wb')\n"
            "output.write(request.data)",
        ),
        (
            "server/local_factory_alias.py",
            "import io\n"
            "def make_stream():\n"
            "    return io.BytesIO()\n"
            "factory = make_stream\n"
            "output = factory()\n"
            "output.write(request.data)",
        ),
    ],
)
def test_retention_verifier_allows_local_stream_and_callable_aliases(
    tmp_path: Path,
    relative_path: str,
    content: str,
):
    repository = _tracked_repo(tmp_path, {relative_path: content + "\n"})

    result = _retention_verifier(repository)

    assert result.returncode == 0, result.stderr
    assert result.stdout == "Sensitive-retention verification passed.\n"
    assert content not in result.stdout + result.stderr


@pytest.mark.parametrize(
    ("relative_path", "content"),
    [
        (
            "server/aliased_sys_module.py",
            "import sys as runtime\n"
            "runtime_alias = runtime\n"
            "out = runtime_alias.stderr\n"
            "forwarded = out\n"
            "forwarded.write(request.data)",
        ),
        (
            "server/aliased_io_module.py",
            "import io as streams\n"
            "stream_module = streams\n"
            "open_file = stream_module.open\n"
            "factory = open_file\n"
            "factory('report.bin', 'wb').write(request.data)",
        ),
        (
            "server/aliased_shelve_module.py",
            "import shelve as storage\n"
            "storage_module = storage\n"
            "open_store = storage_module.open\n"
            "factory = open_store\n"
            "store = factory('reports')\n"
            "store['body'] = request.get_json()",
        ),
        (
            "server/builtins_open.py",
            "import builtins\n"
            "open_file = builtins.open\n"
            "open_file('report.bin', 'wb').write(request.data)",
        ),
        (
            "server/imported_builtin_open.py",
            "from builtins import open as real_open\n"
            "open_file = real_open\n"
            "output = open_file('report.bin', 'wb')\n"
            "output.write(request.data)",
        ),
    ],
)
def test_retention_verifier_rejects_module_and_builtin_factory_aliases(
    tmp_path: Path,
    relative_path: str,
    content: str,
):
    repository = _tracked_repo(tmp_path, {relative_path: content + "\n"})

    result = _retention_verifier(repository)

    assert result.returncode == 1
    assert "Sensitive-retention verification failed" in result.stderr
    assert content not in result.stdout + result.stderr


@pytest.mark.parametrize(
    ("relative_path", "content"),
    [
        (
            "server/local_module_like.py",
            "import io\n"
            "class Runtime:\n"
            "    def __init__(self):\n"
            "        self.stderr = io.BytesIO()\n"
            "runtime = Runtime()\n"
            "out = runtime.stderr\n"
            "out.write(request.data)",
        ),
        (
            "server/overwritten_module_alias.py",
            "import io\n"
            "import sys as runtime\n"
            "class Runtime:\n"
            "    def __init__(self):\n"
            "        self.stderr = io.BytesIO()\n"
            "runtime = Runtime()\n"
            "runtime.stderr.write(request.data)",
        ),
        (
            "server/local_open_function.py",
            "import io\n"
            "def open(*_args):\n"
            "    return io.BytesIO()\n"
            "output = open('report.bin', 'wb')\n"
            "output.write(request.data)",
        ),
        (
            "server/reassigned_open.py",
            "import io\n"
            "def memory_open(*_args):\n"
            "    return io.BytesIO()\n"
            "open = memory_open\n"
            "output = open('report.bin', 'wb')\n"
            "output.write(request.data)",
        ),
        (
            "server/redefined_file_factory.py",
            "import io\n"
            "open_file = io.open\n"
            "def open_file(*_args):\n"
            "    return io.BytesIO()\n"
            "output = open_file('report.bin', 'wb')\n"
            "output.write(request.data)",
        ),
        (
            "server/redefined_path_factory.py",
            "from pathlib import Path\n"
            "OutputPath = Path\n"
            "class OutputPath:\n"
            "    def __init__(self, _path):\n"
            "        pass\n"
            "    def write_bytes(self, value):\n"
            "        return len(value)\n"
            "OutputPath('report.bin').write_bytes(request.data)",
        ),
        (
            "server/overwritten_durable_alias.py",
            "import io\n"
            "open_file = io.open\n"
            "def memory_open(*_args):\n"
            "    return io.BytesIO()\n"
            "open_file = memory_open\n"
            "output = open_file('report.bin', 'wb')\n"
            "output.write(request.data)",
        ),
        (
            "server/import_rebinds_factory.py",
            "import io\n"
            "open_file = io.open\n"
            "from io import BytesIO as open_file\n"
            "output = open_file()\n"
            "output.write(request.data)",
        ),
        (
            "server/parameter_shadows_open.py",
            "def write_locally(open):\n"
            "    output = open('report.bin', 'wb')\n"
            "    output.write(request.data)",
        ),
        (
            "server/import_shadows_module_alias.py",
            "import io\n"
            "import sys as runtime\n"
            "from types import SimpleNamespace as runtime\n"
            "runtime(stderr=io.BytesIO()).stderr.write(request.data)",
        ),
    ],
)
def test_retention_verifier_allows_shadowed_factories_and_module_like_objects(
    tmp_path: Path,
    relative_path: str,
    content: str,
):
    repository = _tracked_repo(tmp_path, {relative_path: content + "\n"})

    result = _retention_verifier(repository)

    assert result.returncode == 0, result.stderr
    assert result.stdout == "Sensitive-retention verification passed.\n"
    assert content not in result.stdout + result.stderr


def test_retention_verifier_accepts_current_server_patterns():
    result = _retention_verifier(ROOT)

    assert result.returncode == 0, result.stderr
    assert result.stdout == "Sensitive-retention verification passed.\n"


@pytest.mark.parametrize(
    "files",
    [
        {
            "server/app.py": (
                "def extract():\n"
                "    return request.data\n"
                "reader = extract\n"
                "open('report.bin', 'wb').write(reader())\n"
            ),
        },
        {
            "server/app.py": (
                "def extract():\n"
                "    return request.data\n"
                "reader = extract\n"
                "forward = reader\n"
                "database.execute('INSERT INTO report VALUES (?)', forward())\n"
            ),
        },
        {
            "server/helpers.py": (
                "def extract():\n"
                "    return request.data\n"
            ),
            "server/app.py": (
                "from server.helpers import extract\n"
                "reader = extract\n"
                "redis_client.set('report', reader())\n"
            ),
        },
        {
            "server/helpers.py": (
                "def extract():\n"
                "    return request.data\n"
            ),
            "server/app.py": (
                "import server.helpers as helpers\n"
                "redis_client.set('report', helpers.extract())\n"
            ),
        },
    ],
)
def test_retention_verifier_rejects_callable_alias_and_cross_file_flows(
    tmp_path: Path,
    files: dict[str, str],
):
    private_canary = "candidate-private-retention-canary"
    repository = _tracked_repo(
        tmp_path,
        {
            path: content.replace("report.bin", private_canary)
            for path, content in files.items()
        },
    )

    result = _retention_verifier(repository)

    assert result.returncode == 1
    assert "durable-content-sink" in result.stderr
    assert private_canary not in result.stdout + result.stderr


@pytest.mark.parametrize(
    "files",
    [
        {
            "server/app.py": (
                "import io\n"
                "def extract():\n"
                "    return request.data\n"
                "reader = extract\n"
                "reader = lambda: b'safe'\n"
                "output = io.BytesIO()\n"
                "output.write(reader())\n"
            ),
        },
        {
            "server/helpers.py": (
                "def safe_value():\n"
                "    return b'safe'\n"
            ),
            "server/app.py": (
                "import io\n"
                "from server.helpers import safe_value as reader\n"
                "output = io.BytesIO()\n"
                "output.write(reader())\n"
            ),
        },
        {
            "server/app.py": (
                "import io\n"
                "def use_reader(reader):\n"
                "    output = io.BytesIO()\n"
                "    output.write(reader())\n"
            ),
        },
    ],
)
def test_retention_verifier_allows_overwritten_and_safe_callable_controls(
    tmp_path: Path,
    files: dict[str, str],
):
    repository = _tracked_repo(tmp_path, files)

    result = _retention_verifier(repository)

    assert result.returncode == 0, result.stderr
    assert result.stdout == "Sensitive-retention verification passed.\n"


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
        "https://resume-analyzer-al3g.onrender.com/static/support.html",
        "iPhone or iPad backups",
        "stored in iCloud or on a Mac or PC",
        "iCloud backups are always encrypted",
        "Computer backups are not encrypted by default",
        "Encrypt local backup",
        "Restoring an existing backup may restore reports deleted from the active app",
        "backup and restore behavior is UNVERIFIED",
        "Raw/original PDF bytes, filenames, resume-input fields, job-description-input fields, installation tokens, and request identifiers are not stored in local reports",
        "Generated feedback and bullet drafts may quote, transform, or restate names, contact information, resume content, or job-description content",
        "Review generated feedback before saving, sharing, or allowing it to enter device backups",
        "Interactive support is not yet available",
        "release candidate",
        "anonymous live reachability",
        "blocks submission",
    ):
        assert disclosure in combined

    backup_disclosure_paths = (
        *required_docs,
        ROOT / "static" / "index.html",
        ROOT / "static" / "privacy.html",
        ROOT / "static" / "support.html",
        ROOT / "docs" / "superpowers" / "specs" / "2026-08-04-resume-analyzer-ios-design.md",
    )
    for path in backup_disclosure_paths:
        disclosure = path.read_text()
        for required_phrase in (
            "iPhone or iPad backups",
            "iCloud",
            "Mac or PC",
            "not encrypted by default",
            "Encrypt local backup",
            "Restoring an existing backup may restore reports deleted from the active app",
        ):
            assert required_phrase in disclosure, path

    release_plan = (
        ROOT / "docs" / "superpowers" / "plans" / "2026-08-04-resume-analyzer-ios.md"
    ).read_text()
    for task_17_observation in (
        "unencrypted computer backup/restore",
        "encrypted computer backup/restore",
        "iCloud backup/restore",
        "deletion and restoration behavior from existing backups",
    ):
        assert task_17_observation in release_plan

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
        "python scripts/check_committed_whitespace.py",
    ):
        assert command in workflow
    assert "permissions:\n  contents: read" in workflow
    assert "22.23.2" in workflow
    assert "3.12" in workflow
    assert "--force" not in workflow
    assert "continue-on-error" not in workflow
    assert "enable-cache: false" in workflow
    assert "cache: npm" not in workflow
    parsed_workflow = yaml.safe_load(workflow)
    checkout = parsed_workflow["jobs"]["verify"]["steps"][0]
    assert checkout["with"]["fetch-depth"] == 0
    whitespace_step = next(
        step
        for step in parsed_workflow["jobs"]["verify"]["steps"]
        if step.get("name") == "Check committed patch whitespace"
    )
    assert "github.event_name" in whitespace_step["run"]
    assert "github.event.before" in whitespace_step["run"]
    assert "github.event.pull_request.base.sha" in whitespace_step["run"]
    assert "github.sha" in whitespace_step["run"]


def test_committed_whitespace_gate_checks_pull_request_and_push_ranges(
    tmp_path: Path,
):
    repository = tmp_path / "whitespace-fixture"
    repository.mkdir()
    assert _run("git", "init", "-q", cwd=repository).returncode == 0
    assert _run("git", "config", "user.name", "Fixture", cwd=repository).returncode == 0
    assert _run("git", "config", "user.email", "fixture@example.invalid", cwd=repository).returncode == 0
    (repository / "report.txt").write_text("clean\n")
    assert _run("git", "add", "report.txt", cwd=repository).returncode == 0
    assert _run("git", "commit", "-qm", "base", cwd=repository).returncode == 0
    base = _run("git", "rev-parse", "HEAD", cwd=repository).stdout.strip()
    (repository / "report.txt").write_text("clean\ntrailing-space \n")
    assert _run("git", "add", "report.txt", cwd=repository).returncode == 0
    assert _run("git", "commit", "-qm", "bad whitespace", cwd=repository).returncode == 0
    head = _run("git", "rev-parse", "HEAD", cwd=repository).stdout.strip()
    script = str(ROOT / "scripts" / "check_committed_whitespace.py")

    pull_request = _run(
        sys.executable,
        script,
        "--event-name",
        "pull_request",
        "--base",
        base,
        "--head",
        head,
        cwd=repository,
    )
    push = _run(
        sys.executable,
        script,
        "--event-name",
        "push",
        "--before",
        base,
        "--head",
        head,
        cwd=repository,
    )
    first_push = _run(
        sys.executable,
        script,
        "--event-name",
        "push",
        "--before",
        "0" * 40,
        "--head",
        head,
        cwd=repository,
    )

    assert pull_request.returncode == 1
    assert push.returncode == 1
    assert first_push.returncode == 1

    (repository / "report.txt").write_text("clean\nwithout trailing whitespace\n")
    assert _run("git", "add", "report.txt", cwd=repository).returncode == 0
    assert _run("git", "commit", "-qm", "fix whitespace", cwd=repository).returncode == 0
    fixed = _run("git", "rev-parse", "HEAD", cwd=repository).stdout.strip()
    result = _run(
        sys.executable,
        script,
        "--event-name",
        "push",
        "--before",
        head,
        "--head",
        fixed,
        cwd=repository,
    )

    assert result.returncode == 0, result.stderr
