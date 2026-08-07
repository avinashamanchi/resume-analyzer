from __future__ import annotations

import ast
from collections import Counter
from dataclasses import replace
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

from scripts import verify_no_sensitive_retention as retention
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
        revenuecat_secret_api_key="sk_" + "r" * 40,
        revenuecat_webhook_secret="w" * 40,
        apple_bundle_id="com.avinashamanchi.resumeai",
        apple_team_id="A1B2C3D4E5",
        apple_jwks_url="https://appleid.apple.com/auth/keys",
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
    assert web_service["name"] == "resume-analyzer-al3g"
    key_value = key_values[0]

    required_fragments = (
        "runtime: python",
        "healthCheckPath: /healthz",
        "APP_ENV",
        "value: production",
        "DEBUG",
        "value: \"false\"",
        "ALLOWED_WEB_ORIGINS",
        "value: https://resume-analyzer-al3g.onrender.com",
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
            "REVENUECAT_SECRET_API_KEY": "sk_" + "r" * 40,
            "REVENUECAT_WEBHOOK_SECRET": "w" * 40,
            "APPLE_BUNDLE_ID": "com.avinashamanchi.resumeai",
            "APPLE_TEAM_ID": "A1B2C3D4E5",
            "APPLE_JWKS_URL": "https://appleid.apple.com/auth/keys",
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
            "REVENUECAT_SECRET_API_KEY": "sk_" + "r" * 40,
            "REVENUECAT_WEBHOOK_SECRET": "w" * 40,
            "APPLE_BUNDLE_ID": "com.avinashamanchi.resumeai",
            "APPLE_TEAM_ID": "A1B2C3D4E5",
            "APPLE_JWKS_URL": "https://appleid.apple.com/auth/keys",
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
            "REVENUECAT_SECRET_API_KEY": "sk_" + "r" * 40,
            "REVENUECAT_WEBHOOK_SECRET": "w" * 40,
            "APPLE_BUNDLE_ID": "com.avinashamanchi.resumeai",
            "APPLE_TEAM_ID": "A1B2C3D4E5",
            "APPLE_JWKS_URL": "https://appleid.apple.com/auth/keys",
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


def _trusted_retention_files() -> dict[str, str]:
    return {
        relative_path: (ROOT / relative_path).read_text()
        for relative_path in (
            "server/app.py",
            "server/gunicorn_logger.py",
            "server/entitlements.py",
            "server/rate_limit.py",
        )
    }


def test_architectural_retention_policy_accepts_only_current_trusted_boundaries(
    tmp_path: Path,
):
    repository = _tracked_repo(tmp_path, _trusted_retention_files())

    result = _retention_verifier(repository)

    assert result.returncode == 0, result.stderr
    assert result.stdout == "Sensitive-retention verification passed.\n"


def test_architectural_retention_policy_pins_python_and_capability_counts():
    assert retention.CANONICAL_AST_PYTHON == (3, 12)
    assert {
        path: dict(
            Counter(
                item.policy
                for item in boundary.approved_capabilities
                for _ in range(item.count)
            )
        )
        for path, boundary in retention.TRUSTED_BOUNDARIES.items()
    } == {
        "server/entitlements.py": {"durable": 55},
        "server/rate_limit.py": {"durable": 19},
        "server/app.py": {"logging": 3},
        "server/gunicorn_logger.py": {"logging": 5},
    }
    assert {
        path: sum(item.count for item in boundary.approved_security_scopes)
        for path, boundary in retention.TRUSTED_BOUNDARIES.items()
    } == {
        "server/entitlements.py": 96,
        "server/rate_limit.py": 60,
        "server/app.py": 36,
        "server/gunicorn_logger.py": 7,
    }


@pytest.mark.parametrize(
    ("relative_path", "old", "new"),
    [
        (
            "server/rate_limit.py",
            "                        transaction.execute()\n",
            (
                "                        transaction.set('extra', 'safe')\n"
                "                        transaction.execute()\n"
            ),
        ),
        (
            "server/app.py",
            '            "status_class": f"{response.status_code // 100}xx",\n',
            (
                '            "status_class": f"{response.status_code // 100}xx",\n'
                '            "extra": "safe",\n'
            ),
        ),
        (
            "server/gunicorn_logger.py",
            "    def access(\n",
            (
                "    def info(self, msg: object) -> None:\n"
                "        super().info('safe')\n\n"
                "    def access(\n"
            ),
        ),
        (
            "server/rate_limit.py",
            "class RateLimiter:\n",
            "class RateLimiter[T: Redis.from_url('type-boundary')]:\n",
        ),
    ],
)
def test_architectural_retention_policy_rejects_trusted_boundary_mutations(
    tmp_path: Path,
    relative_path: str,
    old: str,
    new: str,
):
    files = _trusted_retention_files()
    assert old in files[relative_path]
    files[relative_path] = files[relative_path].replace(old, new, 1)
    repository = _tracked_repo(tmp_path, files)

    result = _retention_verifier(repository)

    assert result.returncode == 1
    assert "trusted-retention-boundary-modified" in result.stderr
    assert "extra" not in result.stderr


def test_architectural_retention_policy_requires_module_and_node_attestations(
    monkeypatch: pytest.MonkeyPatch,
):
    content = _trusted_retention_files()["server/rate_limit.py"]
    mutated = content.replace(
        "class RateLimiter:\n",
        "class RateLimiter[T: Redis.from_url('node-attestation')]:\n",
        1,
    )
    tree = ast.parse(mutated)
    current = retention.TRUSTED_BOUNDARIES["server/rate_limit.py"]
    monkeypatch.setitem(
        retention.TRUSTED_BOUNDARIES,
        "server/rate_limit.py",
        replace(current, module_fingerprint=retention._node_fingerprint(tree)),
    )

    findings = retention.python_project_findings(
        {"server/rate_limit.py": mutated}
    )["server/rate_limit.py"]

    assert "trusted-retention-boundary-modified" in findings
    assert "durable-storage-capability" in findings


def test_architectural_retention_policy_requires_security_scope_attestation(
    monkeypatch: pytest.MonkeyPatch,
):
    content = _trusted_retention_files()["server/app.py"]
    mutated = content.replace(
        "json.dumps(payload, separators=(\",\", \":\"), sort_keys=True) + \"\\n\"",
        "request.data",
        1,
    )
    assert mutated != content
    tree = ast.parse(mutated)
    current = retention.TRUSTED_BOUNDARIES["server/app.py"]
    monkeypatch.setitem(
        retention.TRUSTED_BOUNDARIES,
        "server/app.py",
        replace(current, module_fingerprint=retention._node_fingerprint(tree)),
    )

    findings = retention.python_project_findings(
        {"server/app.py": mutated}
    )["server/app.py"]

    assert "trusted-retention-boundary-modified" in findings
    assert "logging-sink" in findings


def test_architectural_retention_policy_rejects_expected_node_count_drift(
    monkeypatch: pytest.MonkeyPatch,
):
    content = _trusted_retention_files()["server/rate_limit.py"]
    current = retention.TRUSTED_BOUNDARIES["server/rate_limit.py"]
    first, *remaining = current.approved_capabilities
    monkeypatch.setitem(
        retention.TRUSTED_BOUNDARIES,
        "server/rate_limit.py",
        replace(
            current,
            approved_capabilities=(
                replace(first, count=first.count + 1),
                *remaining,
            ),
        ),
    )

    findings = retention.python_project_findings(
        {"server/rate_limit.py": content}
    )["server/rate_limit.py"]

    assert "trusted-retention-boundary-modified" in findings
    assert "durable-storage-capability" in findings


@pytest.mark.parametrize(
    "content",
    [
        "def cache(client):\n    client.set('health', 'ok')\n",
        "def emit(logger):\n    logger.info('safe')\n",
        (
            "def cache(redis_client, method):\n"
            "    sink = getattr(redis_client, method)\n"
            "    sink('health', 'ok')\n"
        ),
        (
            "def emit(logger):\n"
            "    sink = logger.__dict__['info']\n"
            "    sink('safe')\n"
        ),
        "import redis as cache\n",
        "from sqlalchemy import create_engine as connect\n",
        "from pathlib import Path\nwriter = Path.write_text\n",
        "def emit(log):\n    log('safe')\n",
        "emit = print\nemit('safe')\n",
        "def cache(client):\n    sink = client.__dict__['set']\n",
        "def cache(client):\n    sink = vars(client)['execute']\n",
        (
            "import functools\n"
            "def cache(client):\n"
            "    sink = functools.partial(client.set, 'health')\n"
        ),
        "def emit(logger):\n    logger.info(lambda: request.data)\n",
        "import sys\nemit = sys.stderr.write\n",
        "writer = open\nwriter('report.txt', 'w')\n",
        "import os\nwriter = os.open\n",
        "from io import open as writer\n",
        "import tempfile\nwriter = tempfile.NamedTemporaryFile\n",
        "import pathlib\nwriter = pathlib.Path.open\n",
        "from io import FileIO as writer\n",
        "def select(receiver, method):\n    return getattr(receiver, method)\n",
        "def select(receiver, method):\n    return receiver.__dict__[method]\n",
        "def select(receiver, method):\n    return vars(receiver)[method]\n",
        (
            "def select(receiver, method):\n"
            "    first = getattr\n"
            "    second = first\n"
            "    return second(receiver, method)\n"
        ),
        (
            "def select(receiver):\n"
            "    reflect, catalog = getattr, vars\n"
            "    return reflect(receiver, 'safe'), catalog(receiver)\n"
        ),
        "emit, writer = print, open\n",
        (
            "def select(receiver, method):\n"
            "    catalog = receiver.__dict__\n"
            "    alias = catalog\n"
            "    return alias[method]\n"
        ),
        (
            "def select(receiver, method):\n"
            "    return receiver.__getattribute__(method)\n"
        ),
        (
            "import operator\n"
            "selector = operator.attrgetter\n"
            "def select(receiver, method):\n"
            "    return selector(method)(receiver)\n"
        ),
        "from operator import attrgetter as selector\n",
        "from operator import methodcaller as selector\n",
        "import builtins\nemit = builtins.__dict__['print']\n",
        "result = eval('40 + 2')\n",
        "exec('result = 42')\n",
        "code = compile('40 + 2', '<value>', 'eval')\n",
        "module = __import__('sqlite3')\n",
        "import importlib\n",
        "from importlib import import_module as load_module\n",
        "namespace = globals()\n",
        "namespace = locals()\n",
        "emit = __builtins__['print']\n",
        "import builtins\nloader = getattr(builtins, 'eval')\n",
        "def persist(mode):\n    return open('state.txt', mode)\n",
        "def persist():\n    return open('state.txt', 'w')\n",
        "def persist():\n    return open('state.txt', 'not-a-valid-mode')\n",
        "def persist(parts):\n    return open(*parts)\n",
        "def persist(options):\n    return open('state.txt', **options)\n",
        (
            "from pathlib import Path\n"
            "def persist(mode):\n"
            "    return Path('state.txt').open(mode)\n"
        ),
        (
            "from pathlib import Path\n"
            "def persist(options):\n"
            "    return Path('state.txt').open(**options)\n"
        ),
        "import io\ndef persist(mode):\n    return io.open('state.txt', mode)\n",
        "import io\ndef persist():\n    return io.open('state.txt', 'a')\n",
        "import psycopg\n",
        "import psycopg2\n",
        "from psycopg import connect as database_connect\n",
        "import tempfile\nhandle = tempfile.mkstemp\n",
        "import tempfile\nhandle = tempfile.mkstemp()\n",
        "from tempfile import NamedTemporaryFile as temporary_file\n",
        "from tempfile import TemporaryFile as temporary_file\n",
        "import os\nwriter = os.pwrite\n",
        "import os\nwriter = os.writev\n",
        "import os\nwriter = os.ftruncate\n",
        "def persist(handle):\n    handle.truncate(0)\n",
        "import os\ndef persist():\n    return os.open('state.txt', os.O_WRONLY)\n",
        "import os\ncreator = os.creat\n",
        "import dbm\n",
        "from dbm import open as database_open\n",
        "import shutil\ncopier = shutil.copy\n",
        "import shutil\ncopier = shutil.copy2\n",
        "import shutil\ncopier = shutil.copyfile\n",
        "import shutil\ncopier = shutil.copyfileobj\n",
        "import shutil\ncopier = shutil.copytree\n",
        "import runpy\nrunner = runpy.run_path\n",
        "from runpy import run_module as runner\n",
        "import warnings\nwarnings.warn('safe')\n",
        "from warnings import showwarning as emit\n",
        "def emit():\n    return print('safe')\n",
        "def execute():\n    return eval('40 + 2')\n",
    ],
)
def test_architectural_retention_policy_rejects_untrusted_sink_capabilities(
    tmp_path: Path,
    content: str,
):
    repository = _tracked_repo(tmp_path, {"server/feature.py": content})

    result = _retention_verifier(repository)

    assert result.returncode == 1
    assert "capability" in result.stderr or "logging-sink" in result.stderr
    assert "health" not in result.stderr


@pytest.mark.parametrize(
    "content",
    [
        "def read():\n    return open('state.txt')\n",
        "def read():\n    return open('state.txt', 'r')\n",
        "def read():\n    return open('state.txt', mode='rb')\n",
        "def read():\n    return open('state.txt', encoding='utf-8')\n",
        (
            "from pathlib import Path\n"
            "def read():\n"
            "    return Path('state.txt').open('rt')\n"
        ),
        "import io\ndef read():\n    return io.open('state.txt', 'r')\n",
        "import os\ndef read():\n    return os.open('state.txt', os.O_RDONLY)\n",
        (
            "import os as operating\n"
            "def read():\n"
            "    return operating.open('state.txt', operating.O_RDONLY)\n"
        ),
        (
            "from os import O_RDONLY as READ_ONLY\n"
            "import os\n"
            "def read():\n"
            "    return os.open('state.txt', READ_ONLY)\n"
        ),
        (
            "from pathlib import Path\n"
            "def read():\n"
            "    return Path.open(Path('state.txt'), 'r')\n"
        ),
        (
            "import io\n"
            "def parse(payload):\n"
            "    stream = io.BytesIO()\n"
            "    stream.write(payload)\n"
            "    return stream.getvalue()\n"
        ),
    ],
)
def test_architectural_retention_policy_allows_read_only_and_memory_io(
    tmp_path: Path,
    content: str,
):
    repository = _tracked_repo(tmp_path, {"server/feature.py": content})

    result = _retention_verifier(repository)

    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    "content",
    [
        (
            "def print(message):\n"
            "    return message\n"
            "result = print('safe')\n"
        ),
        "def apply(eval):\n    return eval('safe')\n",
        (
            "def outer():\n"
            "    def print(message):\n"
            "        return message\n"
            "    def inner():\n"
            "        return print('safe')\n"
            "    return inner()\n"
        ),
        (
            "def identity(value):\n"
            "    return value\n"
            "print = identity\n"
            "result = print('safe')\n"
        ),
        (
            "def outer():\n"
            "    eval = lambda value: value\n"
            "    def inner():\n"
            "        return eval('safe')\n"
            "    return inner()\n"
        ),
    ],
)
def test_architectural_retention_policy_honors_lexical_builtin_shadowing(
    tmp_path: Path,
    content: str,
):
    repository = _tracked_repo(tmp_path, {"server/feature.py": content})

    result = _retention_verifier(repository)

    assert result.returncode == 0, result.stderr


def test_architectural_retention_policy_rejects_new_operation_in_trusted_file(
    tmp_path: Path,
):
    files = _trusted_retention_files()
    files["server/rate_limit.py"] += (
        "\ndef extra_storage_operation(client):\n"
        "    client.set('architecture-canary', 'safe')\n"
    )
    repository = _tracked_repo(tmp_path, files)

    result = _retention_verifier(repository)

    assert result.returncode == 1
    assert "trusted-retention-boundary-modified" in result.stderr
    assert "architecture-canary" not in result.stdout + result.stderr


def test_entitlement_retention_attestation_rejects_added_redis_operation(
    tmp_path: Path,
):
    files = _trusted_retention_files()
    files["server/entitlements.py"] += (
        "\ndef extra_entitlement_storage(client):\n"
        "    client.set('architecture-canary', 'safe')\n"
    )
    repository = _tracked_repo(tmp_path, files)

    result = _retention_verifier(repository)

    assert result.returncode == 1
    assert "trusted-retention-boundary-modified" in result.stderr
    assert "architecture-canary" not in result.stdout + result.stderr


def test_architectural_retention_policy_allows_request_local_parsing_without_sinks(
    tmp_path: Path,
):
    repository = _tracked_repo(
        tmp_path,
        {
            "server/feature.py": (
                "import io\n"
                "def parse(request):\n"
                "    body = request.get_json()\n"
                "    stream = io.BytesIO()\n"
                "    stream.write(body['resume_text'].encode())\n"
                "    return {'resume': stream.getvalue()}\n"
            )
        },
    )

    result = _retention_verifier(repository)

    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    ("relative_path", "content", "rule"),
    [
        (
            "contracts/request.json",
            '{"properties":{"resume_text":{"type":"string"}}}',
            "sensitive-schema-field",
        ),
        (
            "static/app.js",
            "localStorage.setItem('resume-history', value);",
            "browser-content-history",
        ),
        (
            "server/feature.py",
            "import sqlite3\nconnection = sqlite3.connect('state.db')\n",
            "new-server-retention-store",
        ),
    ],
)
def test_architectural_retention_policy_keeps_non_allowlist_gates(
    tmp_path: Path,
    relative_path: str,
    content: str,
    rule: str,
):
    repository = _tracked_repo(tmp_path, {relative_path: content})

    result = _retention_verifier(repository)

    assert result.returncode == 1
    assert rule in result.stderr


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
        "expo prebuild --platform ios --no-install --clean",
        "git diff --exit-code -- package.json package-lock.json",
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
    assert "eas submit" not in workflow
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
    bad_head = _run("git", "rev-parse", "HEAD", cwd=repository).stdout.strip()
    (repository / "unrelated.txt").write_text("clean tip\n")
    assert _run("git", "add", "unrelated.txt", cwd=repository).returncode == 0
    assert _run("git", "commit", "-qm", "clean unrelated tip", cwd=repository).returncode == 0
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

    assert bad_head != head
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
