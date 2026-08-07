from __future__ import annotations

import base64
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import fakeredis
import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from server.apple_identity import (
    AppleIdentityVerifier,
    InvalidAppleIdentity,
)
from server.entitlements import NonceReplayStore


NOW = datetime.now(UTC).replace(microsecond=0)
RAW_NONCE = "raw-nonce-value-1234"
SUBJECT = "apple-private-subject"


def b64uint(value: int) -> str:
    encoded = value.to_bytes((value.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(encoded).rstrip(b"=").decode()


def jwk(private_key, kid: str = "apple-key-1", **overrides: object) -> dict[str, object]:
    numbers = private_key.public_key().public_numbers()
    value: dict[str, object] = {
        "alg": "RS256",
        "e": b64uint(numbers.e),
        "kid": kid,
        "kty": "RSA",
        "n": b64uint(numbers.n),
        "use": "sig",
    }
    value.update(overrides)
    return value


def token(
    private_key,
    *,
    kid: str = "apple-key-1",
    nonce: str = RAW_NONCE,
    **overrides: object,
) -> str:
    claims: dict[str, object] = {
        "aud": "com.avinashamanchi.resumeai",
        "exp": int((NOW + timedelta(hours=12)).timestamp()),
        "iat": int(NOW.timestamp()),
        "iss": "https://appleid.apple.com",
        "nonce": hashlib.sha256(nonce.encode()).hexdigest(),
        "sub": SUBJECT,
    }
    claims.update(overrides)
    return jwt.encode(claims, private_key, algorithm="RS256", headers={"kid": kid})


def unknown_kid_token(kid: str) -> str:
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "RS256", "kid": kid}, separators=(",", ":")).encode()
    ).rstrip(b"=").decode()
    return f"{header}.e30.c2ln"


class _SlowAppleStream(httpx.SyncByteStream):
    def __init__(self, clock: list[float], body: bytes) -> None:
        self._clock = clock
        self._body = body
        self.yielded = 0

    def __iter__(self):
        first = len(self._body) // 3
        second = first * 2
        for chunk in (
            self._body[:first],
            self._body[first:second],
            self._body[second:],
        ):
            self._clock[0] += 1.1
            self.yielded += 1
            yield chunk


def verifier(
    private_key,
    handler=None,
    *,
    clock: list[datetime] | None = None,
    monotonic=lambda: 1.0,
) -> tuple[AppleIdentityVerifier, list[httpx.Request]]:
    requests: list[httpx.Request] = []
    current = clock if clock is not None else [NOW]

    def default_handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"keys": [jwk(private_key)]})

    selected = handler or default_handler
    http_client = httpx.Client(
        transport=httpx.MockTransport(selected),
        follow_redirects=False,
    )
    replay_store = NonceReplayStore(
        fakeredis.FakeRedis(),
        key_secret=b"nonce-replay-key" * 2,
        now=lambda: current[0],
    )
    return (
        AppleIdentityVerifier(
            http_client=http_client,
            key_secret=b"apple-identity-key" * 2,
            replay_store=replay_store,
            now=lambda: current[0],
            monotonic=monotonic,
        ),
        requests,
    )


def test_valid_rs256_token_derives_stable_domain_separated_opaque_ids():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    first_verifier, requests = verifier(private_key)
    identity = first_verifier.verify(token(private_key), RAW_NONCE)
    assert identity.account_id.startswith("acct_")
    assert identity.revenuecat_app_user_id.startswith("rai_account_")
    assert identity.account_id.removeprefix("acct_") != identity.revenuecat_app_user_id.removeprefix("rai_account_")
    assert SUBJECT not in repr(identity)
    assert len(requests) == 1
    assert str(requests[0].url) == "https://appleid.apple.com/auth/keys"
    assert requests[0].headers["Accept-Encoding"] == "identity"

    second_verifier, _ = verifier(private_key)
    second = second_verifier.verify(token(private_key, nonce="another-nonce-value"), "another-nonce-value")
    assert second.account_id == identity.account_id
    assert second.revenuecat_app_user_id == identity.revenuecat_app_user_id


def test_verifier_accepts_normal_fractional_utc_clock_values():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    clock = [NOW.replace(microsecond=456_000)]
    checked, _ = verifier(private_key, clock=clock)
    identity = checked.verify(token(private_key), RAW_NONCE)
    assert identity.account_id.startswith("acct_")


@pytest.mark.parametrize(
    "claim_overrides",
    [
        {"iss": "https://evil.example"},
        {"aud": "com.example.resumeai"},
        {"exp": int((NOW - timedelta(seconds=1)).timestamp())},
        {"iat": int((NOW + timedelta(minutes=1)).timestamp())},
        {"sub": 123},
        {"exp": "future"},
        {"nonce": "wrong"},
    ],
)
def test_verifier_rejects_wrong_or_typed_claims(claim_overrides: dict[str, object]):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    value = token(private_key, **claim_overrides)
    with pytest.raises(InvalidAppleIdentity) as caught:
        verifier(private_key)[0].verify(value, RAW_NONCE)
    assert str(caught.value) == "invalid_apple_identity"
    assert value not in repr(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None


def test_verifier_rejects_missing_claim_wrong_algorithm_signature_and_kid():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    claims = {
        "aud": "com.avinashamanchi.resumeai",
        "exp": int((NOW + timedelta(hours=1)).timestamp()),
        "iat": int(NOW.timestamp()),
        "iss": "https://appleid.apple.com",
        "nonce": hashlib.sha256(RAW_NONCE.encode()).hexdigest(),
    }
    values = [
        jwt.encode(claims, private_key, algorithm="RS256", headers={"kid": "apple-key-1"}),
        jwt.encode(claims | {"sub": SUBJECT}, "shared-secret" * 3, algorithm="HS256", headers={"kid": "apple-key-1"}),
        token(wrong_key),
        token(private_key, kid="unknown-key"),
    ]
    for value in values:
        with pytest.raises(InvalidAppleIdentity):
            verifier(private_key)[0].verify(value, RAW_NONCE)


@pytest.mark.parametrize(
    ("identity_token", "nonce"),
    [
        ("", RAW_NONCE),
        ("x" * 8_193, RAW_NONCE),
        ("three.parts.only.extra", RAW_NONCE),
        ("token", "short"),
        ("token", "x" * 257),
        ("token", RAW_NONCE + "\n"),
    ],
)
def test_verifier_bounds_token_and_nonce_before_network(identity_token: str, nonce: str):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    checked, requests = verifier(private_key)
    with pytest.raises(InvalidAppleIdentity):
        checked.verify(identity_token, nonce)
    assert requests == []


@pytest.mark.parametrize(
    "keys",
    [
        [jwk(rsa.generate_private_key(public_exponent=65537, key_size=2048), kty="EC")],
        [jwk(rsa.generate_private_key(public_exponent=65537, key_size=2048), use="enc")],
        [jwk(rsa.generate_private_key(public_exponent=65537, key_size=2048), alg="RS512")],
        [
            jwk(rsa.generate_private_key(public_exponent=65537, key_size=2048), kid="dup"),
            jwk(rsa.generate_private_key(public_exponent=65537, key_size=2048), kid="dup"),
        ],
        [jwk(rsa.generate_private_key(public_exponent=65537, key_size=2048), kid=f"k{i}") for i in range(21)],
    ],
)
def test_verifier_rejects_unsafe_jwks_shapes(keys: list[dict[str, object]]):
    signing_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"keys": keys})

    with pytest.raises(InvalidAppleIdentity):
        verifier(signing_key, handler)[0].verify(token(signing_key), RAW_NONCE)
    assert calls == 1


def test_verifier_caps_jwks_and_rejects_duplicate_json():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    bodies = [
        b"{" + b"x" * (64 * 1024) + b"}",
        b'{"keys":[],"keys":[]}',
    ]
    for body in bodies:
        with pytest.raises(InvalidAppleIdentity):
            verifier(
                private_key,
                lambda _request, value=body: httpx.Response(200, content=value),
            )[0].verify(token(private_key), RAW_NONCE)


def test_known_key_cache_avoids_network_and_unexpired_cache_survives_outage():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls > 1:
            raise httpx.ConnectError("private outage")
        return httpx.Response(200, json={"keys": [jwk(private_key)]})

    checked, _ = verifier(private_key, handler)
    checked.verify(token(private_key), RAW_NONCE)
    checked.verify(token(private_key, nonce="another-nonce-value"), "another-nonce-value")
    assert calls == 1


def test_stale_key_is_not_used_during_outage():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    clock = [NOW]
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(200, json={"keys": [jwk(private_key)]})
        raise httpx.ConnectError("private outage")

    checked, _ = verifier(private_key, handler, clock=clock)
    checked.verify(token(private_key), RAW_NONCE)
    clock[0] += timedelta(hours=6, seconds=1)
    with pytest.raises(InvalidAppleIdentity):
        checked.verify(token(private_key, nonce="another-nonce-value"), "another-nonce-value")
    assert calls == 2


def test_successful_nonce_is_consumed_once_under_concurrency():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    checked, _ = verifier(private_key)
    value = token(private_key)
    with ThreadPoolExecutor(max_workers=8) as executor:
        outcomes = list(
            executor.map(
                lambda _: _verify_outcome(checked, value, RAW_NONCE),
                range(8),
            )
        )
    assert outcomes.count("accepted") == 1
    assert outcomes.count("rejected") == 7
    with pytest.raises(InvalidAppleIdentity):
        checked.verify(value, RAW_NONCE)


def _verify_outcome(verifier: AppleIdentityVerifier, value: str, nonce: str) -> str:
    try:
        verifier.verify(value, nonce)
    except InvalidAppleIdentity:
        return "rejected"
    return "accepted"


def test_unknown_kids_are_coalesced_behind_one_refresh_and_cooldown():
    trusted_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"keys": [jwk(trusted_key)]})

    checked, _ = verifier(trusted_key, handler)
    values = []
    for index in range(8):
        untrusted = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        nonce = f"unknown-nonce-{index:04d}"
        values.append((token(untrusted, kid=f"unknown-{index}", nonce=nonce), nonce))
    with ThreadPoolExecutor(max_workers=8) as executor:
        outcomes = list(executor.map(lambda pair: _verify_outcome(checked, *pair), values))
    assert outcomes == ["rejected"] * 8
    assert calls == 1


def test_unique_unknown_kids_use_constant_memory_global_cooldown_and_expire():
    trusted_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    clock = [NOW]
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"keys": [jwk(trusted_key)]})

    checked, _ = verifier(trusted_key, handler, clock=clock)
    checked.verify(token(trusted_key), RAW_NONCE)
    for index in range(2_000):
        with pytest.raises(InvalidAppleIdentity):
            checked.verify(unknown_kid_token(f"attacker-{index}"), RAW_NONCE)
    assert calls == 1
    assert not hasattr(checked, "_negative_kids")

    checked.verify(
        token(trusted_key, nonce="known-during-cooldown"),
        "known-during-cooldown",
    )
    assert calls == 1

    clock[0] += timedelta(seconds=31)
    with pytest.raises(InvalidAppleIdentity):
        checked.verify(unknown_kid_token("attacker-after-expiry"), RAW_NONCE)
    assert calls == 2


def test_jwks_wall_deadline_redirect_and_url_are_fail_closed():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ticks = iter([1.0, 3.1])
    checked, _ = verifier(private_key, monotonic=lambda: next(ticks))
    with pytest.raises(InvalidAppleIdentity):
        checked.verify(token(private_key), RAW_NONCE)

    redirecting = httpx.Client(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={"keys": []})),
        follow_redirects=True,
    )
    with pytest.raises(ValueError, match="redirect"):
        AppleIdentityVerifier(
            http_client=redirecting,
            key_secret=b"apple-identity-key" * 2,
            replay_store=NonceReplayStore(
                fakeredis.FakeRedis(),
                key_secret=b"nonce-replay-key" * 2,
            ),
        )


def test_jwks_total_wall_deadline_is_enforced_during_streaming():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    clock = [4.0]
    body = json.dumps({"keys": [jwk(private_key)]}).encode()
    stream = _SlowAppleStream(clock, body)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    checked, _ = verifier(
        private_key,
        handler,
        monotonic=lambda: clock[0],
    )
    with pytest.raises(InvalidAppleIdentity):
        checked.verify(token(private_key), RAW_NONCE)
    assert stream.yielded == 2
