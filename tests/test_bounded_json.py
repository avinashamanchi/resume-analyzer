from __future__ import annotations

import httpx
import pytest

from server.bounded_json import BoundedJsonError, decode_bounded_json, read_bounded_json


@pytest.mark.parametrize(
    "body",
    [
        b'{"outer":{"same":1,"same":2}}',
        b'{"value":NaN}',
        b'{"value":Infinity}',
        b"\xff",
        b"not-json",
    ],
)
def test_strict_decoder_rejects_duplicate_nonfinite_utf8_and_malformed_json(body: bytes):
    with pytest.raises(BoundedJsonError) as caught:
        decode_bounded_json(body, max_bytes=256)
    assert str(caught.value) == "bounded_json_invalid"
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None


def test_decoder_accepts_exact_cap_and_rejects_cap_plus_one():
    exact = b'{"value":"' + b"x" * 10 + b'"}'
    assert decode_bounded_json(exact, max_bytes=len(exact)) == {"value": "x" * 10}
    with pytest.raises(BoundedJsonError):
        decode_bounded_json(exact, max_bytes=len(exact) - 1)


def test_stream_reader_rejects_declared_and_actual_overflow():
    declared = httpx.Response(
        200,
        headers={"Content-Length": "257"},
        content=b"{}",
    )
    streamed = httpx.Response(200, content=b'{"value":"' + b"x" * 300 + b'"}')
    for response in (declared, streamed):
        with pytest.raises(BoundedJsonError):
            read_bounded_json(response, max_bytes=256)


def test_stream_reader_rejects_malformed_content_length_without_reading():
    response = httpx.Response(
        200,
        headers={"Content-Length": "private-invalid"},
        content=b"{}",
    )
    with pytest.raises(BoundedJsonError) as caught:
        read_bounded_json(response, max_bytes=256)
    assert "private-invalid" not in repr(caught.value)
