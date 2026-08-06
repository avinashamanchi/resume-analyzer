from __future__ import annotations

import json
from pathlib import Path
import struct


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


def test_eas_profiles_are_commit_gated_and_use_the_candidate_origin():
    eas = _read_json(MOBILE / "eas.json")
    assert eas["cli"]["appVersionSource"] == "local"
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
    assert profiles["production"]["autoIncrement"] is False


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
