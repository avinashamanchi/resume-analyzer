from __future__ import annotations

from uuid import UUID

import pytest

from server.errors import ErrorCode
from server.privacy import coarse_ip_key, public_error


REQUEST_ID = UUID("6ef499c6-a2c7-4314-b88b-af45c53da38a")


@pytest.mark.parametrize(
    "raw_address, expected",
    [
        ("203.0.113.97", "203.0.113.0/24"),
        ("2001:db8:abcd:12:ffff::1", "2001:db8:abcd:12::/64"),
        (None, "unknown"),
        ("not-an-ip token=private", "unknown"),
    ],
)
def test_ip_rate_key_is_coarse_and_never_retains_invalid_input(
    raw_address: str | None, expected: str
):
    result = coarse_ip_key(raw_address)

    assert result == expected
    assert "token" not in result


@pytest.mark.parametrize("code", list(ErrorCode))
def test_public_errors_are_versioned_bounded_and_content_free(code: ErrorCode):
    error = public_error(code, REQUEST_ID, retryable=False)
    serialized = error.model_dump(mode="json")

    assert serialized["schemaVersion"] == 1
    assert serialized["code"] == code.value
    assert serialized["requestId"] == str(REQUEST_ID)
    assert 0 < len(serialized["message"]) <= 240
    rendered = str(serialized)
    for private_fragment in (
        "/Users/avi",
        "resume_text",
        "job_description",
        "filename",
        "signed-installation-token",
        "203.0.113.97",
        "llama-3.3-70b-versatile",
        "provider exploded",
    ):
        assert private_fragment not in rendered


def test_public_error_retryability_is_explicit_not_inferred_from_private_state():
    transient = public_error(ErrorCode.AI_TIMEOUT, REQUEST_ID, retryable=True)
    permanent = public_error(ErrorCode.AI_TIMEOUT, REQUEST_ID, retryable=False)

    assert transient.retryable is True
    assert permanent.retryable is False
