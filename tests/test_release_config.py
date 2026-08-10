from __future__ import annotations

import json
from pathlib import Path
import shutil
import struct
import subprocess

import yaml

ROOT = Path(__file__).resolve().parents[1]
MOBILE = ROOT / "mobile"
CANDIDATE_ORIGIN = "https://resume-analyzer-al3g.onrender.com"


def _read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text())


def _png_ihdr(path: Path) -> tuple[int, int, int]:
    raw = path.read_bytes()
    assert raw[:8] == b"\x89PNG\r\n\x1a\n"
    assert raw[12:16] == b"IHDR"
    width, height, _depth, color_type = struct.unpack(">IIBB", raw[16:26])
    return width, height, color_type


def test_ios_release_identity_assets_and_update_policy_are_explicit():
    expo = _read_json(MOBILE / "app.json")["expo"]
    assert expo["name"] == "Resume.AI"
    assert expo["version"] == "1.0.0"
    assert expo["icon"] == "./assets/icon.png"
    assert expo["updates"] == {"enabled": False}
    assert [
        "expo-secure-store",
        {"faceIDPermission": False},
    ] in expo["plugins"]
    assert expo["ios"] == {
        "supportsTablet": False,
        "bundleIdentifier": "com.avinashamanchi.resumeai",
        "buildNumber": "1",
        "icon": "./assets/icon.png",
        "infoPlist": {"ITSAppUsesNonExemptEncryption": False},
    }

    icon = MOBILE / "assets" / "icon.png"
    assert _png_ihdr(icon) == (1024, 1024, 2)


def test_ios_export_runs_the_project_owned_asset_parser_gate():
    package = _read_json(MOBILE / "package.json")
    scripts = package["scripts"]

    assert scripts["verify:release-assets"] == (
        "node scripts/verify-release-assets.mjs"
    )
    assert scripts["preexport:ios"] == "npm run verify:release-assets"
    assert (MOBILE / "scripts" / "verify-release-assets.mjs").is_file()
    workflow = yaml.safe_load((ROOT / ".github" / "workflows" / "verify.yml").read_text())
    commands = {
        step.get("run")
        for job in workflow["jobs"].values()
        for step in job.get("steps", [])
        if isinstance(step, dict)
    }
    assert "npm run verify:release-assets" in commands


def test_release_asset_gate_rejects_a_disguised_image(tmp_path: Path):
    node = shutil.which("node")
    assert node is not None
    (tmp_path / "hostile.png").write_bytes(b"icns" + b"\0" * 64)

    completed = subprocess.run(
        [node, str(MOBILE / "scripts" / "verify-release-assets.mjs"), str(tmp_path)],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 1
    assert "disguised ICNS" in completed.stderr
    assert str(tmp_path) not in completed.stderr


def test_eas_profiles_are_commit_gated_and_use_the_candidate_origin():
    eas = _read_json(MOBILE / "eas.json")
    assert eas["cli"]["appVersionSource"] == "remote"
    assert eas["cli"]["requireCommit"] is True
    assert "submit" not in eas

    profiles = eas["build"]
    for name in ("development", "preview", "production"):
        assert profiles[name]["env"] == {
            "EXPO_PUBLIC_RESUME_API_URL": CANDIDATE_ORIGIN
        }
    assert profiles["development"]["developmentClient"] is True
    assert profiles["development"]["ios"] == {"simulator": False}
    assert profiles["production"]["distribution"] == "store"
    assert profiles["production"]["autoIncrement"] is True
    assert profiles["production"]["ios"] == {"image": "auto"}


def test_release_checklists_keep_external_gates_unverified_or_blocked():
    release = ROOT / "docs" / "release"
    required = {
        "expo-go-checklist.md",
        "device-checklist.md",
        "testflight-checklist.md",
        "app-store-checklist.md",
    }
    assert required <= {path.name for path in release.glob("*.md")}
    combined = "\n".join((release / name).read_text() for name in sorted(required))

    for phrase in (
        "physical iPhone",
        "VoiceOver",
        "Vision OCR",
        "backup",
        "TestFlight",
        "App Store",
        "explicitly authorized",
        "UNVERIFIED",
        "BLOCKED",
    ):
        assert phrase in combined
    assert "No accepted production deployment" in combined
    assert (release / "evidence" / ".gitkeep").exists()


def test_app_store_metadata_candidate_is_valid_and_truthful():
    metadata = _read_json(ROOT / "docs" / "app-store" / "metadata-draft.json")

    assert len(metadata["name"]) <= 30
    assert len(metadata["subtitle"]) <= 30
    assert len(metadata["promotionalText"]) <= 170
    assert len(metadata["description"]) <= 4_000
    assert len(metadata["keywords"].encode("utf-8")) <= 100
    assert " " not in metadata["keywords"]
    assert metadata["primaryCategory"] == "Productivity"
    assert metadata["secondaryCategory"] == "Business"
    assert metadata["privacyPolicyUrl"] == (
        CANDIDATE_ORIGIN + "/static/privacy.html"
    )
    assert metadata["supportUrl"] == CANDIDATE_ORIGIN + "/static/support.html"

    public_copy = " ".join(
        str(metadata[key])
        for key in ("name", "subtitle", "promotionalText", "description")
    ).casefold()
    for unsupported_claim in (
        "exact ats",
        "get hired",
        "guaranteed interview",
        "guaranteed job",
        "is professional advice",
    ):
        assert unsupported_claim not in public_copy
    for disclosure in (
        "deterministic",
        "ai",
        "may be incomplete or wrong",
        "not a hiring decision",
    ):
        assert disclosure in public_copy

    assert metadata["submissionStatus"] == "BLOCKED"
    assert metadata["sellerName"] == "ACCOUNT HOLDER TO CONFIRM"
    purchase_history = metadata["appPrivacyDraft"]["purchaseHistory"]
    assert "Analytics" in purchase_history
    assert "App Functionality" in purchase_history
    assert "not linked" in purchase_history
    assert "not used for tracking" in purchase_history
    assert "userId" not in metadata["appPrivacyDraft"]


def test_render_declares_two_instances_and_every_backend_only_billing_secret():
    render = yaml.safe_load((ROOT / "render.yaml").read_text())
    service = next(item for item in render["services"] if item["type"] == "web")

    assert service["numInstances"] >= 2
    assert {item["key"] for item in service["envVars"]} >= {
        "REVENUECAT_SECRET_API_KEY",
        "REVENUECAT_APP_ID",
        "REVENUECAT_WEBHOOK_SECRET",
        "REVENUECAT_WEBHOOK_SIGNING_SECRET",
        "APPLE_BUNDLE_ID",
        "APPLE_TEAM_ID",
        "APPLE_JWKS_URL",
    }
    assert next(
        item for item in service["envVars"] if item["key"] == "APPLE_BUNDLE_ID"
    )["value"] == "com.avinashamanchi.resumeai"
    assert next(
        item for item in service["envVars"] if item["key"] == "APPLE_JWKS_URL"
    )["value"] == "https://appleid.apple.com/auth/keys"
    assert all(
        "RESUME_AI_LOAD_STAGING_MARKER" != item["key"]
        for item in service["envVars"]
    )


def test_25k_external_evidence_is_explicit_and_has_no_false_completed_gate():
    gates = (ROOT / "docs" / "release" / "resume-ai-25k-external-gates.md").read_text()
    evidence = (ROOT / "docs" / "release" / "25k-load-evidence.md").read_text()

    assert "- [x]" not in gates
    for phrase in (
        "Apple sandbox evidence:",
        "RevenueCat webhook evidence:",
        "Render sustained load evidence:",
        "Signed PDFKit/Vision evidence:",
        "TestFlight evidence:",
        "App Review result:",
        "UNVERIFIED",
    ):
        assert phrase in gates
    for phrase in (
        "Release SHA:",
        "Render service shape:",
        "Redis shape:",
        "Provider mode:",
        "Identity principals seen:",
        "p50 / p95 / p99:",
        "Breaker maxima:",
        "Privacy scan digest:",
        "UNVERIFIED",
    ):
        assert phrase in evidence
    assert "25,000 requests at 5 requests/second requires about 84 minutes" in gates


def test_public_disclosures_match_signed_ios_web_workspace_and_bounded_pro_limits():
    documents = "\n".join(
        path.read_text()
        for path in (
            ROOT / "docs" / "privacy-policy.md",
            ROOT / "docs" / "app-store" / "review-notes-draft.md",
            ROOT / "static" / "privacy.html",
            ROOT / "static" / "terms.html",
        )
    ).casefold()

    for phrase in (
        "signed ios",
        "reviewed text",
        "compatibility web",
        "local resume versions",
        "job notes",
        "device backups",
        "apple",
        "revenuecat",
        "does not sync",
        "200 resume versions",
        "500 tracked jobs",
        "10,000 local reports",
    ):
        assert phrase in documents
    assert "unlimited local report" not in documents
