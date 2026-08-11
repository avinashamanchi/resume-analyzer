from __future__ import annotations

import base64
import json
from uuid import UUID

import pytest

from server.errors import ErrorCode
from server.installations import (
    InstallationTokenService,
    InvalidInstallationToken,
)


def _decode_payload(token: str) -> dict[str, object]:
    encoded_payload = token.split(".", maxsplit=1)[0]
    padding = "=" * (-len(encoded_payload) % 4)
    return json.loads(base64.urlsafe_b64decode(encoded_payload + padding))


def test_installation_token_is_signed_and_uses_a_random_installation_id():
    service = InstallationTokenService(secret=b"x" * 32, now=lambda: 1_000)

    first_token = service.issue()
    second_token = service.issue()

    first_claims = service.verify(first_token)
    second_claims = service.verify(second_token)
    assert isinstance(first_claims.installation_id, UUID)
    assert first_claims.installation_id != second_claims.installation_id
    with pytest.raises(InvalidInstallationToken):
        InstallationTokenService(secret=b"y" * 32, now=lambda: 1_000).verify(
            first_token
        )


def test_installation_token_contains_only_anonymous_versioned_claims():
    token = InstallationTokenService(
        secret=b"x" * 32,
        now=lambda: 1_000,
        ttl_seconds=60,
    ).issue()

    payload = _decode_payload(token)

    assert set(payload) == {"exp", "iat", "installation_id", "version"}
    assert payload["iat"] == 1_000
    assert payload["exp"] == 1_060
    assert payload["version"] == 1
    assert UUID(str(payload["installation_id"]))


def test_expired_or_tampered_token_is_a_content_free_invalid_installation():
    current_time = [1_000]
    service = InstallationTokenService(
        secret=b"x" * 32,
        now=lambda: current_time[0],
        ttl_seconds=60,
    )
    token = service.issue()

    current_time[0] = 1_060
    with pytest.raises(InvalidInstallationToken) as expired:
        service.verify(token)

    tampered = token[:-1] + ("A" if token[-1] != "A" else "B")
    with pytest.raises(InvalidInstallationToken) as modified:
        service.verify(tampered)

    for caught in (expired.value, modified.value):
        assert caught.code is ErrorCode.INVALID_INSTALLATION
        assert caught.retryable is False
        assert str(caught) == "invalid_installation"
        assert token not in repr(caught)
        assert caught.__context__ is None
        assert caught.__cause__ is None


@pytest.mark.parametrize(
    "token",
    [
        "",
        "missing-separator",
        ".",
        "not_base64.signature",
        "e30.signature",
    ],
)
def test_malformed_token_fails_closed(token: str):
    service = InstallationTokenService(secret=b"x" * 32, now=lambda: 1_000)

    with pytest.raises(InvalidInstallationToken) as caught:
        service.verify(token)

    assert caught.value.code is ErrorCode.INVALID_INSTALLATION
    assert caught.value.__context__ is None


def test_v2_issuance_derives_stable_domain_separated_revenuecat_identity():
    service = InstallationTokenService(
        secret=b"x" * 32,
        revenuecat_identity_key=b"revenuecat-identity-key" * 2,
        now=lambda: 1_000,
    )
    issued = service.issue_v2()
    claims = service.verify(issued.installation_token)
    assert issued.revenuecat_app_user_id.startswith("rai_installation_")
    assert issued.revenuecat_app_user_id == service.revenuecat_app_user_id(claims)
    assert str(claims.installation_id) not in issued.revenuecat_app_user_id
    assert issued.installation_token not in repr(issued)


def test_v1_issuance_remains_byte_shape_compatible_after_v2_extension():
    token = InstallationTokenService(secret=b"x" * 32, now=lambda: 1_000).issue()
    assert set(_decode_payload(token)) == {"exp", "iat", "installation_id", "version"}
