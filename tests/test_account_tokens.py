from __future__ import annotations

import base64
import json

import pytest

from server.account_tokens import AccountTokenService, InvalidAccountToken
from server.installations import InstallationTokenService


ACCOUNT_ID = "acct_" + "a" * 43
INSTALLATION_DIGEST = "inst_" + "i" * 43


def payload(token: str) -> dict[str, object]:
    encoded = token.split(".", 1)[0]
    return json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))


def test_account_token_is_canonical_bound_and_expires_within_fifteen_minutes():
    service = AccountTokenService(b"account-token-key" * 2, now=lambda: 1_000)
    issued = service.issue(ACCOUNT_ID, INSTALLATION_DIGEST)
    claims = service.verify(issued.token, INSTALLATION_DIGEST)

    assert claims.account_id == ACCOUNT_ID
    assert claims.installation_digest == INSTALLATION_DIGEST
    assert claims.issued_at == 1_000
    assert claims.expires_at == 1_900
    assert issued.expires_at == 1_900
    assert set(payload(issued.token)) == {
        "account_id",
        "exp",
        "iat",
        "installation_digest",
        "purpose",
        "version",
    }
    assert ACCOUNT_ID not in repr(claims)
    assert issued.token not in repr(issued)


def test_account_token_rejects_tamper_wrong_installation_expiry_and_wrong_purpose():
    clock = [1_000]
    service = AccountTokenService(
        b"account-token-key" * 2,
        now=lambda: clock[0],
        ttl_seconds=60,
    )
    token = service.issue(ACCOUNT_ID, INSTALLATION_DIGEST).token
    invalid = [
        token[:-1] + ("A" if token[-1] != "A" else "B"),
        InstallationTokenService(b"account-token-key" * 2, now=lambda: 1_000).issue(),
    ]
    for value in invalid:
        with pytest.raises(InvalidAccountToken):
            service.verify(value, INSTALLATION_DIGEST)
    with pytest.raises(InvalidAccountToken):
        service.verify(token, "inst_" + "x" * 43)
    clock[0] = 1_060
    with pytest.raises(InvalidAccountToken) as caught:
        service.verify(token, INSTALLATION_DIGEST)
    assert str(caught.value) == "invalid_account_token"
    assert token not in repr(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None


@pytest.mark.parametrize("ttl", [0, 901, True, 1.5])
def test_account_token_rejects_noncanonical_or_overlong_ttl(ttl: object):
    with pytest.raises((TypeError, ValueError)):
        AccountTokenService(
            b"account-token-key" * 2,
            ttl_seconds=ttl,  # type: ignore[arg-type]
        )


@pytest.mark.parametrize(
    ("account_id", "installation_digest"),
    [
        ("", INSTALLATION_DIGEST),
        ("account-raw-subject", INSTALLATION_DIGEST),
        (ACCOUNT_ID, ""),
        (ACCOUNT_ID, "installation:raw-uuid"),
        (ACCOUNT_ID + "\n", INSTALLATION_DIGEST),
    ],
)
def test_account_token_accepts_only_bounded_opaque_claims(
    account_id: str, installation_digest: str
):
    with pytest.raises(ValueError):
        AccountTokenService(b"account-token-key" * 2).issue(
            account_id, installation_digest
        )
