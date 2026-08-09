from __future__ import annotations

import base64
import hashlib
import hmac
import json

import pytest

from server.account_tokens import AccountTokenService, InvalidAccountToken
from server.installations import InstallationTokenService


ACCOUNT_ID = "acct_" + "a" * 43
INSTALLATION_DIGEST = "inst_" + "i" * 43
REVENUECAT_APP_USER_ID = "rai_account_" + "r" * 43
TOKEN_SECRET = b"account-token-key" * 2


def payload(token: str) -> dict[str, object]:
    encoded = token.split(".", 1)[0]
    return json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))


def signed_payload(value: dict[str, object]) -> str:
    encoded = base64.urlsafe_b64encode(
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii")
    ).rstrip(b"=").decode("ascii")
    signature = hmac.digest(
        TOKEN_SECRET,
        b"resume-ai-account-token-v1\x00" + encoded.encode("ascii"),
        hashlib.sha256,
    )
    encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
    return f"{encoded}.{encoded_signature}"


def test_account_token_is_canonical_bound_and_expires_within_fifteen_minutes():
    service = AccountTokenService(TOKEN_SECRET, now=lambda: 1_000)
    issued = service.issue(
        ACCOUNT_ID,
        INSTALLATION_DIGEST,
        REVENUECAT_APP_USER_ID,
    )
    claims = service.verify(issued.token, INSTALLATION_DIGEST)

    assert claims.account_id == ACCOUNT_ID
    assert claims.installation_digest == INSTALLATION_DIGEST
    assert claims.revenuecat_app_user_id == REVENUECAT_APP_USER_ID
    assert claims.issued_at == 1_000
    assert claims.expires_at == 1_900
    assert issued.expires_at == 1_900
    assert set(payload(issued.token)) == {
        "account_id",
        "exp",
        "iat",
        "installation_digest",
        "purpose",
        "revenuecat_app_user_id",
        "version",
    }
    assert ACCOUNT_ID not in repr(claims)
    assert issued.token not in repr(issued)


def test_account_token_rejects_tamper_wrong_installation_expiry_and_wrong_purpose():
    clock = [1_000]
    service = AccountTokenService(
        TOKEN_SECRET,
        now=lambda: clock[0],
        ttl_seconds=60,
    )
    token = service.issue(
        ACCOUNT_ID,
        INSTALLATION_DIGEST,
        REVENUECAT_APP_USER_ID,
    ).token
    encoded, signature = token.split(".")
    changed_claims = payload(token)
    changed_claims["revenuecat_app_user_id"] = "rai_account_" + "x" * 43
    changed_encoded = base64.urlsafe_b64encode(
        json.dumps(
            changed_claims,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii")
    ).rstrip(b"=").decode("ascii")
    invalid = [
        token[:-1] + ("A" if token[-1] != "A" else "B"),
        f"{changed_encoded}.{signature}",
        InstallationTokenService(TOKEN_SECRET, now=lambda: 1_000).issue(),
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


@pytest.mark.parametrize(
    "revenuecat_app_user_id",
    [
        "rai_installation_wrong-scope",
        "rai_account_short",
        123,
    ],
)
def test_account_token_rejects_signed_but_invalid_revenuecat_account_claim(
    revenuecat_app_user_id: object,
):
    service = AccountTokenService(TOKEN_SECRET, now=lambda: 1_000)
    valid = service.issue(
        ACCOUNT_ID,
        INSTALLATION_DIGEST,
        REVENUECAT_APP_USER_ID,
    ).token
    claims = payload(valid)
    claims["revenuecat_app_user_id"] = revenuecat_app_user_id

    with pytest.raises(InvalidAccountToken):
        service.verify(signed_payload(claims), INSTALLATION_DIGEST)


@pytest.mark.parametrize("ttl", [0, 901, True, 1.5])
def test_account_token_rejects_noncanonical_or_overlong_ttl(ttl: object):
    with pytest.raises((TypeError, ValueError)):
        AccountTokenService(
            TOKEN_SECRET,
            ttl_seconds=ttl,  # type: ignore[arg-type]
        )


@pytest.mark.parametrize(
    ("account_id", "installation_digest", "revenuecat_app_user_id"),
    [
        ("", INSTALLATION_DIGEST, REVENUECAT_APP_USER_ID),
        ("account-raw-subject", INSTALLATION_DIGEST, REVENUECAT_APP_USER_ID),
        (ACCOUNT_ID, "", REVENUECAT_APP_USER_ID),
        (ACCOUNT_ID, "installation:raw-uuid", REVENUECAT_APP_USER_ID),
        (ACCOUNT_ID + "\n", INSTALLATION_DIGEST, REVENUECAT_APP_USER_ID),
        (ACCOUNT_ID, INSTALLATION_DIGEST, ""),
        (ACCOUNT_ID, INSTALLATION_DIGEST, "rai_installation_wrong-scope"),
        (ACCOUNT_ID, INSTALLATION_DIGEST, REVENUECAT_APP_USER_ID + "\n"),
    ],
)
def test_account_token_accepts_only_bounded_opaque_claims(
    account_id: str,
    installation_digest: str,
    revenuecat_app_user_id: str,
):
    with pytest.raises(ValueError):
        AccountTokenService(TOKEN_SECRET).issue(
            account_id,
            installation_digest,
            revenuecat_app_user_id,
        )
