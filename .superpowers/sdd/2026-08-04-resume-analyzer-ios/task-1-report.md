# Task 1 report — backend foundation and shared contracts

## Implementation

- Added a Python 3.12 `uv` project with locked runtime and development dependencies; `requirements.txt` is the frozen, hash-pinned production export.
- Added `Settings.from_environ`, including production-only rejection of debug mode, missing or placeholder secrets, missing/invalid Redis configuration, wildcard CORS, non-HTTPS public origins, and invalid deadline ordering.
- Added strict Pydantic v1 response and public-error contracts. Analysis output has the required `schemaVersion`, `analysisId`, `sourceType`, `score`, and `feedback` fields; unknown fields are rejected at every model boundary. The score also verifies that its component total and score label are internally consistent.
- Added canonical JSON Schema artifacts and a valid/invalid cross-runtime analysis fixture pair.
- Replaced the legacy key-bearing Flask script with the requested compatibility entrypoint. `server.app.create_app` stores injected settings and an intentionally empty `ServiceRegistry` seam; it does not register future Task 6 routes or services.

## Files changed

- `.python-version`
- `pyproject.toml`
- `uv.lock`
- `requirements.txt`
- `app.py`
- `server/__init__.py`
- `server/app.py`
- `server/config.py`
- `server/contracts.py`
- `server/errors.py`
- `contracts/analysis-v1.schema.json`
- `contracts/error-v1.schema.json`
- `contracts/fixtures/analysis-valid.json`
- `contracts/fixtures/analysis-invalid-extra-key.json`
- `tests/test_config.py`
- `tests/test_contracts.py`

## TDD evidence

1. RED tests were written first in `tests/test_config.py` and `tests/test_contracts.py`.
2. The initial command could not execute because the legacy repository did not declare `pytest`:

   ```text
   error: Failed to spawn: `pytest`
   Caused by: No such file or directory (os error 2)
   ```

3. After adding only the test-runner project configuration, the exact required RED command failed during collection for the intended reason:

   ```text
   E   ModuleNotFoundError: No module named 'server'
   2 errors in 0.35s
   ```

4. After the smallest foundation implementation, the focused suite was GREEN:

   ```text
   ............                                                             [100%]
   12 passed in 0.08s
   ```

5. During self-review, a wire-format `PublicErrorV1` regression test exposed
   strict enum rejection for the JSON string `"ai_timeout"`:

   ```text
   Input should be an instance of ErrorCode
   1 failed in 0.08s
   ```

   A `code` before-validator now converts only recognized wire strings to the
   stable enum. Its targeted GREEN result was `1 passed in 0.08s`.

## Final verification

Executed from `/Users/avi/Documents/ios/resume-analyzer/.worktrees/resume-analyzer-ios-implementation`:

```text
$ uv lock
Resolved 40 packages in 6ms

$ uv export --frozen --no-dev --format requirements-txt --output-file requirements.txt
... generated the frozen, hash-pinned requirements export ...

$ uv run pytest tests/test_config.py tests/test_contracts.py -q
.............                                                            [100%]
13 passed in 0.07s

$ uv run python -m compileall -q app.py server
(exit 0; no output)

$ git diff --check
(exit 0; no output)
```

## Self-review

- Confirmed strict extra-field rejection against the required invalid fixture and public-error contract.
- Confirmed a raw wire-format public error code validates to its stable enum without relaxing strict validation for unknown codes.
- Confirmed production configuration rejects every safety condition named by the task brief, while development configuration accepts explicit origins and deadlines.
- Confirmed the compatibility `app.py` no longer contains an embedded Groq key path, debug server, legacy public route, or raw-exception response path.
- Kept `ServiceRegistry` deliberately empty: concrete parser/scorer/AI/token/rate-limit/lease members are deferred to Task 6 exactly as scoped.
- Reviewed formatting with `git diff --check` and compiled the new entrypoint/package.

## Concerns

No known Task 1 defects. The application intentionally has no product routes yet; endpoint registration and concrete services are deferred to Task 6.

## Fix Round 1

### Changes

- Made `ScoreComponentsV1.keywords` required while retaining `int | None`, so Pydantic now matches the canonical JSON Schema: omitted is invalid and explicit `null` remains valid.
- Strengthened production Redis URL validation to require a `redis`/`rediss` scheme plus both a netloc and parsed hostname.
- Added focused parity and hostless-Redis regression tests.

### TDD evidence

The exact Task 1 command first failed for both intended regressions:

```text
FAILED tests/test_config.py::test_production_rejects_hostless_redis_url - Failed: DID NOT RAISE <class 'server.config.ConfigurationError'>
FAILED tests/test_contracts.py::test_analysis_contract_requires_keywords_but_allows_explicit_null - Failed: DID NOT RAISE <class 'pydantic_core._pydantic_core.ValidationError'>
2 failed, 13 passed in 0.11s
```

After the minimal contract and URL-validation changes, the same command was GREEN:

```text
$ uv run pytest tests/test_config.py tests/test_contracts.py -q
...............                                                          [100%]
15 passed in 0.07s
```

### Self-review

- The null regression changes the readiness score and label to 70/`Good`, so it proves explicit null acceptance without bypassing score-total or label consistency.
- Hostless `redis://` and malformed authority-only Redis URLs are rejected without weakening the existing missing-Redis, scheme, CORS, deadline, debug, or secret checks.
- `git diff --check` completed with exit 0 after the GREEN test run.
