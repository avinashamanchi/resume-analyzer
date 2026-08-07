# Resume.AI 25k Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a guest-first, RevenueCat-funded Resume.AI foundation that preserves deterministic scoring under AI failure, enforces paid AI allowances on the server, keeps flagship workflow data local, and passes measured 25k-MAU capacity gates.

**Architecture:** Extend the current Flask/Redis boundary with a strict v2 contract, header-only pre-body admission, atomic plan quotas, optional Apple-linked paid identity, and an independently degrading AI result. Extend the Expo SDK 54 app with reviewed on-device extraction, server-verified plan state, keyset-paginated SQLite repositories, and local role-version/comparison/job-tracker modules; raw resume and job content never enters cloud application storage.

**Tech Stack:** Python 3.12, Flask 3, Pydantic 2, Redis, Groq SDK, httpx, PyJWT with cryptography, Gunicorn, pytest/fakeredis; Expo SDK 54, React Native 0.81, Expo Router 6, TypeScript 5.9, Zod 4, expo-sqlite, expo-secure-store, expo-apple-authentication, RevenueCat `react-native-purchases`, Jest/Testing Library, Swift PDFKit/Vision.

## Global Constraints

- Capacity gate: 5 accepted analyses/second for 15 minutes plus a one-second 20-analysis burst repeated every four seconds for 120 seconds.
- Global analysis token bucket: 5 requests/second refill with capacity 20.
- Global provider limit: 48 concurrent reservations with 15-second TTL; provider deadline 8 seconds; total request deadline 10 seconds.
- PDF limit: 8 concurrent globally, 2 concurrent per process, 20 MiB declared PDF bytes per process, 10 MiB per PDF, 10 pages, and 11 MiB total request size.
- Free AI allowance: 3 provider dispatches per UTC calendar month; Pro AI allowance: 100 provider dispatches per UTC calendar month.
- Per installation: 30 analyses/minute, 300/day, and 5 provider dispatches/minute; optional account: 60 analyses/minute, 600/day, and 10 provider dispatches/minute.
- Existing authorized installations are never rejected solely because many users share an IP prefix.
- RevenueCat identifiers are exactly `resume_pro`, `com.avinashamanchi.resumeai.pro.monthly`, and `com.avinashamanchi.resumeai.pro.annual`.
- Sign in with Apple is optional and is used only for cross-device paid identity; local reports, versions, and jobs never sync.
- Signed iOS builds submit reviewed text, not raw PDFs; Expo Go keeps paste-text and fixture flows.
- Deterministic `resume-readiness-v1` scoring does not depend on Apple, RevenueCat, Groq, plan verification, or AI capacity, and AI never changes its values.
- Telemetry contains no IP or IP digest, installation/account identifier or digest, RevenueCat user ID, Apple subject/token, filename, resume/job text, feedback, local company/role/notes, raw exception, or provider response.
- Local report history has no Pro plan cap but enforces a 10,000-record device safety cap and keyset pages of at most 50 records.
- Do not claim 25k readiness until Apple sandbox/TestFlight, RevenueCat webhook/alias, and production-like Render load gates have recorded evidence.

---

## File map

- `contracts/analysis-v2.schema.json` and `contracts/fixtures/analysis-v2-*.json`: canonical independently degrading response contract.
- `server/plans.py`: plan snapshots, UTC allowance windows, and strict plan types.
- `server/entitlements.py`: RevenueCat-verified plan cache and atomic monthly dispatch reservations.
- `server/revenuecat.py`: content-free RevenueCat REST client and webhook decoder.
- `server/apple_identity.py`: Apple JWT/nonce verification and opaque account derivation.
- `server/admission.py`: header-only analysis admission, global/provider/PDF reservations, and per-process emergency/PDF budgets.
- `server/telemetry.py`: bounded-label counters, histograms, and gauges.
- `server/routes.py`: v2 installation, analysis, sync, Apple identity, and RevenueCat webhook routes while retaining v1.
- `server/request.py`: strict v2 multipart parsing after admission.
- `server/contracts.py`, `server/config.py`, `server/app.py`, `server/production.py`, `server/errors.py`: composition and public boundaries for the new units.
- `mobile/src/api/planApi.ts`: plan-sync and Apple-identity client.
- `mobile/src/security/accountIdentity.ts`: SecureStore-backed optional account session.
- `mobile/src/billing/revenueCatService.ts` and `mobile/src/billing/BillingProvider.tsx`: explicit app-user identity, server verification, purchase/restore/login state.
- `mobile/src/documents/visionAdapter.ts` and `mobile/modules/resume-vision/ios/ResumeVisionCore.swift`: bounded PDFKit-first/Vision extraction.
- `mobile/app/review-extraction.tsx`: mandatory reviewed-text editor before mobile submission.
- `mobile/src/storage/reportRepository.ts` and `mobile/src/storage/migrations.ts`: report schema v2 and keyset pagination.
- `mobile/src/workspace/contracts.ts`, `mobile/src/workspace/migrations.ts`, `mobile/src/workspace/workspaceRepository.ts`, and `mobile/src/workspace/compareVersions.ts`: local-only role versions, revisions, comparisons, and jobs.
- `mobile/app/versions/*`, `mobile/app/compare.tsx`, and `mobile/app/jobs/*`: flagship local workflow routes.
- `tests/load/analysis_load.py`: deterministic 25,000-principal sustained/burst runner with fixture-only input.
- `docs/release/25k-load-evidence.md`, `docs/app-store/monetization-setup.md`, and `docs/release/resume-ai-25k-external-gates.md`: measured and external release receipts.

### Task 1: Freeze the v2 degradation contract

**Files:**
- Create: `contracts/analysis-v2.schema.json`
- Create: `contracts/fixtures/analysis-v2-complete.json`
- Create: `contracts/fixtures/analysis-v2-deterministic-only.json`
- Modify: `server/contracts.py`
- Modify: `mobile/src/domain/contracts.ts`
- Modify: `tests/test_contracts.py`
- Modify: `mobile/__tests__/contracts.test.ts`

**Interfaces:**
- Consumes: existing `ScoreV1`, `FeedbackV1`, `ScoreSchema`, and `FeedbackSchema`.
- Produces: Python `AiAllowanceV2`, `AiResultV2`, `AnalysisResponseV2`; TypeScript `AiAllowanceSchema`, `AiResultSchema`, `AnalysisResponseV2Schema`, and `AnalysisResponseV2`.
- `AiResultV2.status` is `complete | not_requested | quota_exhausted | plan_verification_unavailable | temporarily_unavailable | timeout | invalid_provider_response`.

- [ ] **Step 1: Add failing Python contract tests**

```python
def test_v2_accepts_score_when_ai_is_unavailable():
    payload = json.loads(Path("contracts/fixtures/analysis-v2-deterministic-only.json").read_text())
    parsed = AnalysisResponseV2.model_validate(payload)
    assert parsed.score.readinessScore == 78
    assert parsed.ai.status == "temporarily_unavailable"
    assert parsed.ai.feedback is None

def test_v2_rejects_feedback_for_non_complete_status():
    payload = json.loads(Path("contracts/fixtures/analysis-v2-complete.json").read_text())
    payload["ai"]["status"] = "quota_exhausted"
    with pytest.raises(ValidationError):
        AnalysisResponseV2.model_validate(payload)
```

- [ ] **Step 2: Run the Python tests and verify red**

Run: `uv run pytest tests/test_contracts.py -q`

Expected: FAIL because `AnalysisResponseV2` and both fixtures do not exist.

- [ ] **Step 3: Add the strict Python models and JSON Schema**

```python
AiStatusV2 = Literal[
    "complete", "not_requested", "quota_exhausted",
    "plan_verification_unavailable", "temporarily_unavailable",
    "timeout", "invalid_provider_response",
]

class AiAllowanceV2(StrictContract):
    used: int = Field(ge=0, le=100)
    limit: Literal[3, 100]
    resetsAt: datetime

    @model_validator(mode="after")
    def used_does_not_exceed_limit(self) -> AiAllowanceV2:
        if self.used > self.limit:
            raise ValueError("used exceeds allowance limit")
        return self

class AiResultV2(StrictContract):
    status: AiStatusV2
    feedback: FeedbackV1 | None
    allowance: AiAllowanceV2 | None

    @model_validator(mode="after")
    def enforces_status_payload(self) -> AiResultV2:
        if (self.status == "complete") != (self.feedback is not None):
            raise ValueError("feedback is present only for complete AI results")
        return self

class AnalysisResponseV2(StrictContract):
    schemaVersion: Literal[2]
    analysisId: UUID
    sourceType: Literal["reviewed_text", "pdf"]
    score: ScoreV1
    ai: AiResultV2
```

Use the complete fixture values from the design spec. The deterministic-only
fixture uses the same score and sets `ai` to
`{"status":"temporarily_unavailable","feedback":null,"allowance":{"used":0,"limit":3,"resetsAt":"2026-09-01T00:00:00Z"}}`.

- [ ] **Step 4: Add failing TypeScript parity tests**

```typescript
it('accepts deterministic v2 output without feedback', () => {
  const value = AnalysisResponseV2Schema.parse(deterministicOnlyFixture);
  expect(value.ai.status).toBe('temporarily_unavailable');
  expect(value.ai.feedback).toBeNull();
});

it('rejects feedback unless status is complete', () => {
  expect(() => AnalysisResponseV2Schema.parse({
    ...completeFixture,
    ai: { ...completeFixture.ai, status: 'quota_exhausted' },
  })).toThrow();
});
```

- [ ] **Step 5: Run mobile contract tests and verify red**

Run: `cd mobile && npm test -- --runInBand __tests__/contracts.test.ts`

Expected: FAIL because `AnalysisResponseV2Schema` is not exported.

- [ ] **Step 6: Implement the discriminated Zod contract**

```typescript
export const AiAllowanceSchema = z.object({
  used: z.number().int().min(0).max(100),
  limit: z.union([z.literal(3), z.literal(100)]),
  resetsAt: z.string().datetime({ offset: true }),
}).strict().refine(value => value.used <= value.limit, 'used exceeds allowance limit');

const AiUnavailableSchema = z.object({
  status: z.enum(['not_requested', 'quota_exhausted', 'plan_verification_unavailable',
    'temporarily_unavailable', 'timeout', 'invalid_provider_response']),
  feedback: z.null(),
  allowance: AiAllowanceSchema.nullable(),
}).strict();

export const AiResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('complete'), feedback: FeedbackSchema,
    allowance: AiAllowanceSchema }).strict(),
  AiUnavailableSchema,
]);
```

- [ ] **Step 7: Run both contract suites and commit**

Run: `uv run pytest tests/test_contracts.py -q && cd mobile && npm test -- --runInBand __tests__/contracts.test.ts`

Expected: both commands PASS.

```bash
git add contracts/analysis-v2.schema.json contracts/fixtures/analysis-v2-complete.json contracts/fixtures/analysis-v2-deterministic-only.json server/contracts.py tests/test_contracts.py mobile/src/domain/contracts.ts mobile/__tests__/contracts.test.ts
git commit -m "feat: add independently degrading analysis v2 contract"
```

### Task 2: Establish verified plan identity and atomic AI allowances

**Files:**
- Create: `server/plans.py`
- Create: `server/entitlements.py`
- Create: `server/revenuecat.py`
- Create: `server/apple_identity.py`
- Create: `tests/test_entitlements.py`
- Create: `tests/test_revenuecat.py`
- Create: `tests/test_apple_identity.py`
- Modify: `server/config.py`
- Modify: `tests/test_config.py`
- Modify: `server/contracts.py`
- Modify: `pyproject.toml`
- Modify: `uv.lock`

**Interfaces:**
- Produces: `PlanKind = Literal["free", "pro"]`; `PlanSnapshot(kind, verified_until, entitlement_expires_at)`; `AllowanceSnapshot(used, limit, resets_at)`; `AiAllowanceStore.reserve(subject_key, plan, request_id) -> AiAllowanceReservation`.
- `AiAllowanceReservation.begin_dispatch()` atomically charges once; `release()` removes an uncharged reservation; `snapshot()` returns the current visible allowance.
- Produces: `RevenueCatClient.fetch_plan(app_user_id, deadline) -> PlanSnapshot`; `RevenueCatWebhook.decode(headers, body) -> RevenueCatEvent`; `AppleIdentityVerifier.verify(identity_token, nonce) -> AppleIdentity`.
- `AppleIdentity(account_id, revenuecat_app_user_id)` contains opaque HMAC-derived values only.

- [ ] **Step 1: Write failing allowance-window and duplicate tests**

```python
def test_free_and_pro_limits_reset_at_utc_month_boundary(redis_client):
    now = datetime(2026, 8, 31, 23, 59, tzinfo=UTC)
    store = AiAllowanceStore(redis_client, key_secret=b"k" * 32, now=lambda: now)
    free = store.reserve("installation:one", "free", UUID(int=1))
    assert free.snapshot().limit == 3
    assert free.begin_dispatch().used == 1
    pro = store.reserve("account:two", "pro", UUID(int=2))
    assert pro.snapshot().limit == 100

def test_duplicate_request_cannot_charge_twice(redis_client):
    store = AiAllowanceStore(redis_client, key_secret=b"k" * 32)
    first = store.reserve("installation:one", "free", UUID(int=9))
    second = store.reserve("installation:one", "free", UUID(int=9))
    assert first.begin_dispatch().used == 1
    assert second.begin_dispatch().used == 1
```

- [ ] **Step 2: Run and verify red**

Run: `uv run pytest tests/test_entitlements.py tests/test_config.py -q`

Expected: FAIL because the plan and allowance modules do not exist.

- [ ] **Step 3: Implement strict plan values and month windows**

```python
FREE_AI_LIMIT = 3
PRO_AI_LIMIT = 100

@dataclass(frozen=True, slots=True)
class AllowanceSnapshot:
    used: int
    limit: Literal[3, 100]
    resets_at: datetime

def utc_month_window(now: datetime) -> tuple[str, datetime]:
    current = now.astimezone(UTC)
    if current.month == 12:
        reset = datetime(current.year + 1, 1, 1, tzinfo=UTC)
    else:
        reset = datetime(current.year, current.month + 1, 1, tzinfo=UTC)
    return f"{current.year:04d}-{current.month:02d}", reset
```

Use one Redis transaction for request-reservation and charged-count keys. Key
material is `HMAC(key_secret, scope + NUL + subject_key)`; values contain only
integer counts and 15-second reservation owner nonces.

- [ ] **Step 4: Add production configuration tests**

```python
def test_production_requires_revenuecat_and_apple_values():
    with pytest.raises(ConfigurationError):
        Settings.from_environ(PRODUCTION_ENV)
```

Add exact settings: `revenuecat_secret_api_key`, `revenuecat_webhook_secret`,
`apple_bundle_id`, `apple_team_id`, and `apple_jwks_url`. Production requires
non-example secrets of at least 32 characters, bundle ID
`com.avinashamanchi.resumeai`, and JWKS URL `https://appleid.apple.com/auth/keys`.

- [ ] **Step 5: Run the allowance and configuration tests**

Run: `uv run pytest tests/test_entitlements.py tests/test_config.py -q`

Expected: PASS, including 3/100 exhaustion, UTC reset, duplicate request, Redis
outage, and HMAC-key privacy cases.

#### RevenueCat and Apple verification

The remaining steps complete the same server-owned plan boundary with strict
`PlanSnapshotV2`, `EntitlementSyncRequestV2`, `AppleIdentityRequestV2`, and
`AppleIdentityResponseV2` Pydantic models.

- [ ] **Step 1: Write failing RevenueCat boundary tests**

```python
def test_fetch_plan_accepts_only_resume_pro(httpx_mock):
    httpx_mock.add_response(json={"subscriber": {"entitlements": {
        "resume_pro": {"expires_date": "2026-09-01T00:00:00Z"}}}})
    snapshot = client.fetch_plan("rai_install_opaque", deadline=2.0)
    assert snapshot.kind == "pro"

def test_webhook_requires_constant_time_bearer_and_is_idempotent():
    event = webhook.decode({"Authorization": "Bearer webhook-secret-value"}, EVENT_BODY)
    assert event.event_id == "evt_01"
    assert event.app_user_id == "rai_account_opaque"
```

- [ ] **Step 2: Write failing Apple verification tests**

```python
def test_apple_verifier_checks_audience_nonce_and_derives_opaque_ids(apple_keys):
    identity = verifier.verify(apple_keys.token(
        aud="com.avinashamanchi.resumeai", nonce=sha256(b"raw-nonce").hexdigest()
    ), "raw-nonce")
    assert identity.account_id.startswith("acct_")
    assert identity.revenuecat_app_user_id.startswith("rai_account_")
    assert "apple-subject" not in repr(identity)
```

- [ ] **Step 3: Run and verify red**

Run: `uv run pytest tests/test_revenuecat.py tests/test_apple_identity.py -q`

Expected: FAIL because both modules are absent.

- [ ] **Step 4: Add the exact dependency and clients**

Add `"PyJWT[crypto]>=2.10,<3"` to project dependencies and run
`uv lock`. RevenueCat requests use an injected `httpx.Client`, the configured
server-side bearer credential, a two-second deadline, no automatic retry, and generic
`EntitlementUnavailable` failures. Apple verification uses cached JWKS for at
most six hours and calls:

```python
claims = jwt.decode(
    identity_token,
    signing_key,
    algorithms=["RS256"],
    audience="com.avinashamanchi.resumeai",
    issuer="https://appleid.apple.com",
    options={"require": ["exp", "iat", "iss", "aud", "sub", "nonce"]},
)
if not hmac.compare_digest(claims["nonce"], hashlib.sha256(nonce.encode()).hexdigest()):
    raise InvalidAppleIdentity()
```

- [ ] **Step 10: Run the complete plan-identity tests and commit**

Run: `uv run pytest tests/test_revenuecat.py tests/test_apple_identity.py tests/test_contracts.py -q`

Expected: PASS with invalid signature, issuer, audience, expiry, nonce,
entitlement, timeout, malformed JSON, and secret-redaction cases.

```bash
git add pyproject.toml uv.lock server/plans.py server/entitlements.py server/config.py server/revenuecat.py server/apple_identity.py server/contracts.py tests/test_entitlements.py tests/test_config.py tests/test_revenuecat.py tests/test_apple_identity.py
git commit -m "feat: verify plan identity and monthly AI allowances"
```

### Task 3: Build header-only admission and capacity breakers

**Files:**
- Create: `server/admission.py`
- Create: `tests/test_admission.py`
- Modify: `server/rate_limit.py`
- Modify: `tests/test_rate_limit.py`
- Modify: `server/app.py`
- Modify: `server/errors.py`

**Interfaces:**
- Produces: `AdmissionRequest(installation_id, account_id, request_id, source, ai_requested, content_length)`; `AdmissionDecision(ai_status, allowance, lease)`; `AdmissionController.admit(request) -> AdmissionDecision`.
- `AdmissionLease.release()` compare-deletes provider/PDF reservations and releases local PDF counters exactly once.
- Flask stores the decision at `g.resume_ai_admission` before form parsing.

- [ ] **Step 1: Add failing pre-body and concurrency tests**

```python
def test_full_provider_breaker_degrades_before_body_read(admission, unread_body):
    admission.fill_provider_slots(48)
    decision = admission.admit(ai_request(content_length=2048))
    assert decision.ai_status == "temporarily_unavailable"
    assert unread_body.reads == 0

def test_pdf_breaker_refuses_ninth_global_pdf_before_body(admission):
    controllers = [admission.for_process(index) for index in range(5)]
    leases = [controllers[index // 2].admit(pdf_request()) for index in range(8)]
    with pytest.raises(AdmissionRejected) as caught:
        controllers[4].admit(pdf_request())
    assert caught.value.code is ErrorCode.CAPACITY_LIMITED
    for decision in leases:
        decision.lease.release()

def test_shared_nat_is_not_an_analysis_denial_key(admission, clock):
    decisions = []
    for index in range(100):
        if index and index % 5 == 0:
            clock.advance(1)
        decision = admission.admit(
            request_for_installation(index, ip="203.0.113.0/24")
        )
        decisions.append(decision)
        decision.lease.release()
    assert len(decisions) == 100
```

- [ ] **Step 2: Run and verify red**

Run: `uv run pytest tests/test_admission.py tests/test_rate_limit.py -q`

Expected: FAIL because admission types and `capacity_limited` do not exist.

- [ ] **Step 3: Implement exact constants and decisions**

```python
GLOBAL_RATE_PER_SECOND = 5
GLOBAL_BURST = 20
PROVIDER_CONCURRENCY = 48
RESERVATION_TTL_SECONDS = 15
PDF_GLOBAL_CONCURRENCY = 8
PDF_PROCESS_CONCURRENCY = 2
PDF_PROCESS_BYTES = 20 * 1024 * 1024
EMERGENCY_SCORE_RATE = 2

AiAdmissionStatus = Literal[
    "admitted", "not_requested", "quota_exhausted",
    "plan_verification_unavailable", "temporarily_unavailable",
]
```

Use a Redis Lua script for the global token bucket and provider/PDF slots so a
worker cannot oversubscribe between reads. Use a locked in-process counter for
PDF process slots/bytes. Analysis limits use installation/account keys only;
canonical IP prefixes remain restricted to installation issuance and a global
flood signal.

- [ ] **Step 4: Install the Flask pre-body hook**

```python
@app.before_request
def admit_analysis_before_body() -> None:
    if request.path != "/v2/analyses" or request.method != "POST":
        return
    services = _services_from_app(app)
    headers = parse_admission_headers(request.headers, request.content_length)
    identity = authorize_headers_only(headers, services)
    g.resume_ai_admission = services.admission.admit(
        AdmissionRequest.from_headers(identity, headers)
    )

@app.teardown_request
def release_admission(_: BaseException | None) -> None:
    decision = getattr(g, "resume_ai_admission", None)
    if decision is not None:
        decision.lease.release()
```

- [ ] **Step 5: Prove the hook has not read multipart input**

Add a WSGI input spy test that fails if `read`, `readline`, or `readinto` is
called before the admission fake records its decision. Cover invalid content
length, missing headers, PDF budget, provider degradation, Redis emergency
score path, and teardown release.

- [ ] **Step 6: Run tests and commit**

Run: `uv run pytest tests/test_admission.py tests/test_rate_limit.py tests/test_routes.py -q`

Expected: PASS; the v1 route remains unchanged.

```bash
git add server/admission.py server/rate_limit.py server/app.py server/errors.py tests/test_admission.py tests/test_rate_limit.py
git commit -m "feat: admit v2 analyses before reading request bodies"
```

### Task 4: Return scores independently from optional AI

**Files:**
- Modify: `server/request.py`
- Modify: `server/routes.py`
- Modify: `server/app.py`
- Modify: `server/production.py`
- Modify: `tests/test_routes.py`
- Modify: `tests/test_production_composition.py`

**Interfaces:**
- Consumes: `g.resume_ai_admission`, `AnalysisResponseV2`, `AiAllowanceStore`, existing scorer, PDF parser, and AI gateway.
- Produces: `parse_analysis_request_v2(request, admitted_source) -> ParsedAnalysisRequest`; `POST /v2/analyses`; `POST /v2/entitlements/sync`; `POST /v2/identity/apple`; `POST /v2/revenuecat/webhook`.

- [ ] **Step 1: Add failing route degradation tests**

```python
@pytest.mark.parametrize(("failure", "status"), [
    (PublicServiceError(ErrorCode.AI_TIMEOUT, retryable=True), "timeout"),
    (PublicServiceError(ErrorCode.AI_UNAVAILABLE, retryable=True), "temporarily_unavailable"),
    (PublicServiceError(ErrorCode.INVALID_AI_RESPONSE), "invalid_provider_response"),
])
def test_v2_keeps_score_when_ai_fails(client, harness, failure, status):
    harness.ai_gateway.failure = failure
    response = submit_v2_reviewed_text(client, ai="requested")
    assert response.status_code == 200
    body = AnalysisResponseV2.model_validate(response.get_json())
    assert body.score.readinessScore >= 0
    assert body.ai.status == status
    assert body.ai.feedback is None
```

- [ ] **Step 2: Add failing quota-charge tests**

```python
def test_allowance_charges_only_when_dispatch_begins(client, harness):
    harness.admission.ai_status = "quota_exhausted"
    body = submit_v2_reviewed_text(client, ai="requested").get_json()
    assert body["ai"]["status"] == "quota_exhausted"
    assert harness.ai_gateway.calls == []
    assert harness.allowances.begin_calls == []

def test_provider_timeout_charges_one_reserved_unit(client, harness):
    harness.ai_gateway.failure = PublicServiceError(ErrorCode.AI_TIMEOUT, retryable=True)
    submit_v2_reviewed_text(client, ai="requested")
    assert len(harness.allowances.begin_calls) == 1
```

- [ ] **Step 3: Run and verify red**

Run: `uv run pytest tests/test_routes.py tests/test_production_composition.py -q`

Expected: FAIL because the v2 routes are absent.

- [ ] **Step 4: Implement strict v2 parsing and response assembly**

```python
def _v2_ai_result(parsed, score, admission, services, started_at):
    if admission.ai_status != "admitted":
        return AiResultV2(status=admission.ai_status, feedback=None,
                          allowance=admission.allowance)
    charged = admission.allowance_reservation.begin_dispatch()
    try:
        feedback = services.ai_gateway.analyze(
            parsed.resume_text, parsed.job_description,
            remaining_provider_deadline(started_at),
        )
        return AiResultV2(status="complete", feedback=feedback, allowance=charged)
    except PublicServiceError as error:
        return AiResultV2(status=ai_status_for(error.code), feedback=None,
                          allowance=charged)
```

Calculate `score = services.scorer(...)` before `_v2_ai_result`. A scoring,
input, auth, or PDF safety error remains a public non-200 response. Provider
exceptions map to the three content-free v2 statuses and never reach the
generic error handler.

- [ ] **Step 5: Implement billing and identity endpoints**

`/v2/entitlements/sync` queries RevenueCat using the app-user ID derived from
the authenticated installation/account and writes a 25-hour maximum cache.
`/v2/identity/apple` consumes a one-use nonce stored under the installation,
verifies the token, and returns a 15-minute account token plus opaque RevenueCat
app user ID. `/v2/revenuecat/webhook` validates the bearer secret and atomically
applies event time ordering/idempotency.

- [ ] **Step 6: Compose production services**

Add `admission`, `allowances`, `entitlements`, `revenuecat`, `apple_identity`,
and `telemetry` fields to `ServiceRegistry`. Derive independent runtime HMAC
keys for `plan-cache`, `allowance`, `admission`, and `apple-account` purposes.

- [ ] **Step 7: Run server suites and commit**

Run: `uv run pytest tests/test_routes.py tests/test_production_composition.py tests/test_production_boundary.py -q`

Expected: PASS with v1 compatibility, score-only states, quota semantics,
strict source-header/body match, webhook idempotency, and content-free errors.

```bash
git add server/request.py server/routes.py server/app.py server/production.py tests/test_routes.py tests/test_production_composition.py
git commit -m "feat: preserve deterministic scores across AI failures"
```

### Task 5: Make mobile purchase state server-verifiable

**Files:**
- Create: `mobile/src/api/planApi.ts`
- Create: `mobile/src/security/accountIdentity.ts`
- Create: `mobile/__tests__/planApi.test.ts`
- Create: `mobile/__tests__/accountIdentity.test.ts`
- Modify: `mobile/src/security/installationToken.ts`
- Modify: `mobile/src/billing/revenueCatService.ts`
- Modify: `mobile/src/billing/BillingProvider.tsx`
- Modify: `mobile/__tests__/billingService.test.ts`
- Modify: `mobile/__tests__/billingProvider.test.tsx`
- Modify: `mobile/package.json`
- Modify: `mobile/package-lock.json`

**Interfaces:**
- Produces: `PlanApi.sync(identity, signal) -> Promise<VerifiedPlanSnapshot>` and `PlanApi.linkApple(identityToken, nonce, signal) -> Promise<AccountIdentity>`.
- Produces: `AccountIdentityStore.get/set/clear`; stored fields are `accountToken`, `expiresAt`, and `revenueCatAppUserId` only.
- Extends `RevenueCatModule` with `getAppUserID()`, `logIn(appUserID)`, and `logOut()`.
- `BillingContextValue.planStatus` is `loading | free | pro_verified | pro_verification_needed` and includes `allowance`.

- [ ] **Step 1: Write failing API and identity-store tests**

```typescript
it('does not accept the SDK entitlement as server plan proof', async () => {
  const api = new PlanApi({ fetchImpl, apiBaseUrl, installationTokens, accountIdentity });
  fetchImpl.mockResolvedValue(response(200, verifiedFreePlan));
  await expect(api.sync(new AbortController().signal)).resolves.toMatchObject({ kind: 'free' });
});

it('stores only the bounded account session fields', async () => {
  await store.set({ accountToken: 'signed', expiresAt: '2026-08-07T20:00:00Z',
    revenueCatAppUserId: 'rai_account_opaque' });
  expect(JSON.parse(secureStore.setItemAsync.mock.calls[0][1])).toEqual({
    accountToken: 'signed', expiresAt: '2026-08-07T20:00:00Z',
    revenueCatAppUserId: 'rai_account_opaque',
  });
});
```

- [ ] **Step 2: Run and verify red**

Run: `cd mobile && npm test -- --runInBand __tests__/planApi.test.ts __tests__/accountIdentity.test.ts __tests__/billingService.test.ts __tests__/billingProvider.test.tsx`

Expected: FAIL because plan API, account identity, and explicit RevenueCat IDs
are absent.

- [ ] **Step 3: Add Apple authentication and RevenueCat identity methods**

Run: `cd mobile && npx expo install expo-apple-authentication`

Configure RevenueCat with the installation response's
`revenueCatAppUserId`. Purchase and restore call `PlanApi.sync`; only its signed
response sets `pro_verified`. Implement:

```typescript
export type VerifiedPlanSnapshot = Readonly<{
  schemaVersion: 2;
  kind: 'free' | 'pro';
  verifiedUntil: string;
  entitlementExpiresAt: string | null;
  allowance: Readonly<{ used: number; limit: 3 | 100; resetsAt: string }>;
}>;
```

- [ ] **Step 4: Implement optional account linking**

Generate 32 random bytes, send SHA-256 nonce to Apple, send the raw nonce and
identity token to `PlanApi.linkApple`, store the bounded response, call
`purchases.logIn(response.revenueCatAppUserId)`, then call `sync`. Clearing the
account calls `logOut`, clears SecureStore, and reconfigures the installation
identity; it never deletes local repositories.

- [ ] **Step 5: Run mobile tests and commit**

Run: `cd mobile && npm test -- --runInBand __tests__/planApi.test.ts __tests__/accountIdentity.test.ts __tests__/billingService.test.ts __tests__/billingProvider.test.tsx && npm run typecheck`

Expected: PASS, including expired sessions, aborts, malformed responses,
purchase/restore sync, Apple cancellation, login alias failure, and server
verification outage.

```bash
git add mobile/package.json mobile/package-lock.json mobile/src/api/planApi.ts mobile/src/security/accountIdentity.ts mobile/src/security/installationToken.ts mobile/src/billing/revenueCatService.ts mobile/src/billing/BillingProvider.tsx mobile/__tests__/planApi.test.ts mobile/__tests__/accountIdentity.test.ts mobile/__tests__/billingService.test.ts mobile/__tests__/billingProvider.test.tsx
git commit -m "feat: bind mobile purchases to verified plan state"
```

### Task 6: Submit reviewed on-device extraction

**Files:**
- Create: `mobile/app/review-extraction.tsx`
- Create: `mobile/__tests__/reviewExtraction.test.tsx`
- Modify: `mobile/modules/resume-vision/ios/ResumeVisionCore.swift`
- Modify: `mobile/modules/resume-vision/ios/ResumeVisionModule.swift`
- Modify: `mobile/modules/resume-vision/native-tests/main.swift`
- Modify: `mobile/src/documents/visionAdapter.ts`
- Modify: `mobile/src/analysis/analysisCoordinator.ts`
- Modify: `mobile/src/api/resumeApi.ts`
- Modify: `mobile/app/_layout.tsx`
- Modify: `mobile/__tests__/visionAdapter.test.ts`
- Modify: `mobile/__tests__/analysisCoordinator.test.ts`
- Modify: `mobile/__tests__/resumeApi.test.ts`

**Interfaces:**
- Native `extractTextFromPdf(uri, operationId) -> {text, pageCount}` becomes PDFKit-first with Vision fallback per page while keeping the JavaScript signature.
- Produces `ReviewedExtractionDraft(text, pageCount, sourceLease, generation)` in coordinator memory only.
- `ResumeApi` v2 sends headers `X-Resume-Source: reviewed_text` and `X-Resume-AI: requested | not_requested`; its multipart body contains text, never a PDF, for native flows.

- [ ] **Step 1: Add failing Swift extraction tests**

```swift
try require(extractFixture("text-resume.pdf").text.contains("Experience"), "PDFKit text")
try require(extractFixture("scanned-resume.pdf").pageCount == 1, "Vision fallback")
try requireThrows { try extractFixture("eleven-pages.pdf") }
```

- [ ] **Step 2: Add failing review/submission tests**

```typescript
it('submits only user-reviewed text for a picked PDF', async () => {
  await coordinator.completeVisionReview(authority, 'Reviewed safe text');
  await coordinator.analyze();
  expect(api.analyze).toHaveBeenCalledWith(expect.objectContaining({
    source: { kind: 'reviewed_text', text: 'Reviewed safe text' },
  }), expect.any(AbortSignal));
  expect(api.analyze.mock.calls[0][0]).not.toHaveProperty('uri');
});
```

- [ ] **Step 3: Run and verify red**

Run: `cd mobile && npm test -- --runInBand __tests__/visionAdapter.test.ts __tests__/analysisCoordinator.test.ts __tests__/resumeApi.test.ts __tests__/reviewExtraction.test.tsx`

Expected: FAIL because `reviewed_text` and the review route do not exist.

- [ ] **Step 4: Implement bounded PDFKit-first extraction**

In Swift, validate cache ownership, file size, page count, cancellation token,
and a 30,000-code-point aggregate before returning. For each `PDFPage`, use
`page.string` when nonblank; otherwise render at bounded scale and run
`VNRecognizeTextRequest`. Do not write extracted text or rendered page images.

- [ ] **Step 5: Implement the mandatory review route**

Render a bounded multiline editor, page count, `Only the reviewed text will be
sent`, Cancel, and `Use reviewed text`. `Use reviewed text` calls
`completeVisionReview` and clears the route draft after the coordinator issues
a committed receipt. Backgrounding cancels native work and performs exact
cache cleanup.

- [ ] **Step 6: Send strict v2 reviewed-text requests**

```typescript
headers: {
  Authorization: `Installation ${token}`,
  'X-Resume-Source': 'reviewed_text',
  'X-Resume-AI': input.aiRequested ? 'requested' : 'not_requested',
  ...(accountToken === null ? {} : { 'X-Resume-Account': accountToken }),
}
```

- [ ] **Step 7: Run tests and commit**

Run: `cd mobile && npm test -- --runInBand __tests__/visionAdapter.test.ts __tests__/analysisCoordinator.test.ts __tests__/resumeApi.test.ts __tests__/reviewExtraction.test.tsx && npm run typecheck`

Expected: PASS, including cancellation, backgrounding, invalid OCR output,
unavailable native module, raw-PDF absence, and cleanup receipt cases.

```bash
git add mobile/app/review-extraction.tsx mobile/app/_layout.tsx mobile/modules/resume-vision/ios/ResumeVisionCore.swift mobile/modules/resume-vision/ios/ResumeVisionModule.swift mobile/modules/resume-vision/native-tests/main.swift mobile/src/documents/visionAdapter.ts mobile/src/analysis/analysisCoordinator.ts mobile/src/api/resumeApi.ts mobile/__tests__/reviewExtraction.test.tsx mobile/__tests__/visionAdapter.test.ts mobile/__tests__/analysisCoordinator.test.ts mobile/__tests__/resumeApi.test.ts
git commit -m "feat: review PDF text on device before analysis"
```

### Task 7: Build paginated local flagship workflows

**Files:**
- Modify: `mobile/src/storage/migrations.ts`
- Modify: `mobile/src/storage/reportRepository.ts`
- Modify: `mobile/test-utils/fakeReportDatabase.ts`
- Modify: `mobile/src/controllers/AppController.tsx`
- Modify: `mobile/src/components/ReportList.tsx`
- Modify: `mobile/app/(tabs)/history.tsx`
- Modify: `mobile/__tests__/reportRepository.test.ts`
- Modify: `mobile/__tests__/historyFlow.test.tsx`
- Create: `mobile/src/workspace/contracts.ts`
- Create: `mobile/src/workspace/migrations.ts`
- Create: `mobile/src/workspace/workspaceRepository.ts`
- Create: `mobile/src/workspace/compareVersions.ts`
- Create: `mobile/__tests__/workspaceRepository.test.ts`
- Create: `mobile/__tests__/compareVersions.test.ts`
- Create: `mobile/app/versions/index.tsx`
- Create: `mobile/app/versions/[versionId].tsx`
- Create: `mobile/app/compare.tsx`
- Create: `mobile/app/jobs/index.tsx`
- Create: `mobile/app/jobs/[jobId].tsx`
- Create: `mobile/src/components/AiStatusCard.tsx`
- Create: `mobile/__tests__/versionsFlow.test.tsx`
- Create: `mobile/__tests__/comparisonFlow.test.tsx`
- Create: `mobile/__tests__/jobsFlow.test.tsx`
- Create: `mobile/__tests__/aiDegradationFlow.test.tsx`
- Modify: `mobile/src/controllers/runtime.ts`
- Modify: `mobile/src/storage/DataProvider.tsx`
- Modify: `mobile/app/(tabs)/_layout.tsx`
- Modify: `mobile/app/results/[analysisId].tsx`
- Modify: `mobile/app/upgrade.tsx`
- Modify: `mobile/app/(tabs)/settings.tsx`

**Interfaces:**
- Produces `ReportCursor = {createdAt: string; id: string}` and `ReportPage = {items: readonly ReportRecord[]; nextCursor: ReportCursor | null}`.
- Replaces `ReportRepositoryPort.list()` with `listPage({before, limit}): Promise<ReportPage>`; `limit` is 1 through 50.
- `HistoryController.loadInitial()` requests 25; `loadMore()` requests 25 and coalesces duplicate calls.
- Produces `ResumeVersion`, `VersionSnapshot`, `JobRecord`, `WorkspacePage<T>`, and `VersionComparison` strict Zod-backed types.
- `WorkspaceRepository` provides `saveVersion`, `addSnapshot`, `listVersions`, `getVersion`, `deleteVersion`, `saveJob`, `listJobs`, `deleteJob`, and `deleteAll`.
- `compareVersions(left, right) -> VersionComparison` is pure and local; the routes consume verified plan state and never cloud-sync workspace content.

- [ ] **Step 1: Write failing keyset tests**

```typescript
it('uses stable created_at and id keyset pagination', async () => {
  const first = await repository.listPage({ before: null, limit: 25 });
  const second = await repository.listPage({ before: first.nextCursor, limit: 25 });
  expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(50);
  expect(database.lastSql).toContain('(created_at < ? OR (created_at = ? AND id < ?))');
});

it('rejects the 10001st report before writing', async () => {
  database.count = 10_000;
  await expect(repository.save({ result: validFixture })).rejects.toBeInstanceOf(LocalStorageError);
});
```

- [ ] **Step 2: Run and verify red**

Run: `cd mobile && npm test -- --runInBand __tests__/reportRepository.test.ts __tests__/historyFlow.test.tsx`

Expected: FAIL because `listPage` and schema version 2 are absent.

- [ ] **Step 3: Migrate and implement keyset queries**

Schema version 2 adds
an `ai_status TEXT NOT NULL DEFAULT 'complete'` column and
`CREATE INDEX reports_created_id_desc ON reports(created_at DESC, id DESC)`.
Existing rows attest as `complete`. New deterministic-only rows store the exact
v2 AI status and JSON `null` in the existing `feedback_json` column; plan
allowance is transient and is not copied into report history. `ReportRecord`
therefore exposes `aiStatus` plus nullable `feedback`, and result screens render
feedback only when `aiStatus === 'complete'`.
Query `limit + 1` rows and derive the cursor from the last returned record:

```typescript
export type ReportPageRequest = Readonly<{ before: ReportCursor | null; limit: number }>;
export type ReportPage = Readonly<{ items: readonly ReportRecord[]; nextCursor: ReportCursor | null }>;
```

Before insert, execute `SELECT COUNT(*) AS count FROM reports`; reject at
10,000. Keep existing privacy projections and transactional deletion.

- [ ] **Step 4: Virtualize the History screen**

Change `ReportList` to a `FlatList` with `keyExtractor`, `onEndReached`, an
accessible loading footer, and delete-in-place. `HistoryController` owns
`nextCursor`, `loadingMore`, and a serialized request authority so stale pages
cannot overwrite a refresh.

- [ ] **Step 5: Run the pagination tests**

Run: `cd mobile && npm test -- --runInBand __tests__/reportRepository.test.ts __tests__/historyFlow.test.tsx && npm run typecheck`

Expected: PASS for migration, cursor ties, empty/final pages, coalescing,
deletion during pagination, corrupt rows, and the safety cap.

#### Local workspace repository

- [ ] **Step 6: Write failing privacy and transaction tests**

```typescript
it('writes a role version only after explicit save', async () => {
  expect(await repository.listVersions({ before: null, limit: 25 })).toMatchObject({ items: [] });
  await repository.saveVersion(explicitVersionInput);
  expect(database.rows.resume_versions).toHaveLength(1);
});

it('deleting a version and its revisions is atomic', async () => {
  database.failOn('DELETE FROM version_snapshots');
  await expect(repository.deleteVersion(VERSION_ID)).rejects.toBeInstanceOf(WorkspaceStorageError);
  expect(database.rows.resume_versions).toHaveLength(1);
});
```

- [ ] **Step 7: Write failing deterministic comparison tests**

```typescript
it('compares score components, keywords, and changed lines locally', () => {
  expect(compareVersions(left, right)).toEqual({
    scoreDelta: 7,
    componentDeltas: { structure: 2, impact: 3, readability: 1, keywords: 1 },
    addedKeywords: ['Redis'],
    removedKeywords: [],
    addedLines: ['Built an audited Redis limiter.'],
    removedLines: ['Built backend services.'],
  });
});
```

- [ ] **Step 8: Run workspace tests and verify red**

Run: `cd mobile && npm test -- --runInBand __tests__/workspaceRepository.test.ts __tests__/compareVersions.test.ts`

Expected: FAIL because workspace modules do not exist.

- [ ] **Step 9: Implement the exact local schema**

Create `resume-ai-workspace.db` with the three tables from the design and
foreign keys enabled. Text bounds are 30,000 code points for resume text,
20,000 for job descriptions, 120 for titles/company/role labels, and 2,000 for
notes. Status is `saved | applied | interviewing | offer | rejected | archived`.
Maximum active counts are enforced from verified plan input: Free 1 version/3
jobs; Pro 200 versions/500 jobs.

- [ ] **Step 10: Implement local comparisons**

Normalize line endings to `\n`, compare at most 2,000 lines, preserve displayed
text exactly, and cap added/removed output at 500 lines each. Keyword comparison
uses the existing Unicode 15 normalization. No network or AI dependency is
accepted by the function signature.

- [ ] **Step 11: Compose the workspace lifecycle**

Extend `DataProvider` with a separately identified workspace repository and the
same serialized open/close ownership guarantees as reports. A failure blocks
workspace screens but does not block analysis or report history.

- [ ] **Step 12: Run the workspace tests**

Run: `cd mobile && npm test -- --runInBand __tests__/workspaceRepository.test.ts __tests__/compareVersions.test.ts && npm run typecheck`

Expected: PASS for schemas, plan limits, pages, revisions, atomic delete,
delete-all, corrupt rows, Unicode bounds, and deterministic comparison.

#### Flagship screens and honest AI state

- [ ] **Step 13: Write failing degradation and quota UI tests**

```typescript
it.each(['quota_exhausted', 'plan_verification_unavailable', 'temporarily_unavailable', 'timeout'])(
  'keeps the score visible for %s', status => {
    const view = renderResult(v2Result({ status, feedback: null }));
    expect(view.getByText('78/100')).toBeTruthy();
    expect(view.queryByText('Analysis failed')).toBeNull();
  },
);
```

- [ ] **Step 14: Write failing flagship flow tests**

```typescript
it('does not persist a role-targeted local draft until Save version on this device', async () => {
  const view = renderVersionDraft();
  expect(repository.saveVersion).not.toHaveBeenCalled();
  fireEvent.press(view.getByRole('button', { name: 'Save version on this device' }));
  await waitFor(() => expect(repository.saveVersion).toHaveBeenCalledTimes(1));
});

it('job status changes never call a network client', async () => {
  const view = renderJobEditor();
  fireEvent.press(view.getByRole('button', { name: 'Mark interviewing' }));
  await waitFor(() => expect(repository.saveJob).toHaveBeenCalled());
  expect(fetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 15: Run flagship tests and verify red**

Run: `cd mobile && npm test -- --runInBand __tests__/versionsFlow.test.tsx __tests__/comparisonFlow.test.tsx __tests__/jobsFlow.test.tsx __tests__/aiDegradationFlow.test.tsx`

Expected: FAIL because routes and `AiStatusCard` do not exist.

- [ ] **Step 16: Render the deterministic-first result**

Render `ScoreCard` before `AiStatusCard`. `AiStatusCard` maps each status to a
fixed message and action. `quota_exhausted` shows allowance/reset and plan
choice; `plan_verification_unavailable` offers verification retry;
`temporarily_unavailable`/`timeout` offer a manual AI retry that reuses reviewed
input only while it remains in current-session memory.

- [ ] **Step 17: Implement versions and comparison routes**

Require the local-storage disclosure before the first save. Initialize a
role-targeted local copy from reviewed text and show optional bounded AI
suggestions beside it without auto-applying them. Free may save one version and
compare it with the current unsaved result; Pro may select any two saved
versions. Comparison renders component deltas, keyword changes, and line changes
from `VersionComparison` without a network call.

- [ ] **Step 18: Implement local job routes**

Fields are company label, role label, status, optional next-action date, notes,
and linked local version. Save/delete receipts are visible and content-free.
There are no email, calendar, scraping, notification, or application controls.

- [ ] **Step 19: Update plan and identity copy**

Upgrade and Settings show server-verified state and `used of limit AI feedback
this month`. Add `Use Pro on my other devices` only when StoreKit entitlement is
active. Explicitly state `Your reports, resume versions, and jobs stay on this
device and do not sync.`

- [ ] **Step 20: Run the complete local workflow tests and commit**

Run: `cd mobile && npm test -- --runInBand __tests__/versionsFlow.test.tsx __tests__/comparisonFlow.test.tsx __tests__/jobsFlow.test.tsx __tests__/aiDegradationFlow.test.tsx __tests__/paidFeatureGates.test.tsx __tests__/upgradeFlow.test.tsx && npm run typecheck`

Expected: PASS with VoiceOver roles, 200% Dynamic Type snapshots, small-screen
scrolling, plan limits, and no-cloud-call assertions.

```bash
git add mobile/src/storage/migrations.ts mobile/src/storage/reportRepository.ts mobile/test-utils/fakeReportDatabase.ts mobile/src/controllers/AppController.tsx mobile/src/components/ReportList.tsx 'mobile/app/(tabs)/history.tsx' mobile/src/workspace mobile/src/controllers/runtime.ts mobile/src/storage/DataProvider.tsx mobile/app/versions mobile/app/compare.tsx mobile/app/jobs mobile/src/components/AiStatusCard.tsx 'mobile/app/(tabs)/_layout.tsx' 'mobile/app/results/[analysisId].tsx' mobile/app/upgrade.tsx 'mobile/app/(tabs)/settings.tsx' mobile/__tests__/reportRepository.test.ts mobile/__tests__/historyFlow.test.tsx mobile/__tests__/workspaceRepository.test.ts mobile/__tests__/compareVersions.test.ts mobile/__tests__/versionsFlow.test.tsx mobile/__tests__/comparisonFlow.test.tsx mobile/__tests__/jobsFlow.test.tsx mobile/__tests__/aiDegradationFlow.test.tsx
git commit -m "feat: add paginated local career workspace"
```

### Task 8: Gate privacy-safe scale and external deployment

**Files:**
- Create: `server/telemetry.py`
- Create: `tests/test_telemetry.py`
- Create: `tests/load/analysis_load.py`
- Create: `tests/load/generate_installation_tokens.py`
- Create: `tests/load/test_analysis_load.py`
- Modify: `server/app.py`
- Modify: `server/routes.py`
- Modify: `server/gunicorn_logger.py`
- Modify: `scripts/verify_no_sensitive_retention.py`
- Modify: `tests/test_privacy.py`
- Create: `docs/release/25k-load-evidence.md`
- Create: `docs/release/resume-ai-25k-external-gates.md`
- Modify: `docs/app-store/monetization-setup.md`
- Modify: `docs/app-store/review-notes-draft.md`
- Modify: `docs/privacy-policy.md`
- Modify: `static/privacy.html`
- Modify: `static/terms.html`
- Modify: `render.yaml`
- Modify: `Procfile`
- Modify: `tests/test_release_config.py`

**Interfaces:**
- Produces `Telemetry.counter(name, labels)`, `histogram(name, value, labels)`, and `gauge(name, value, labels)` with enumerated label schemas.
- Load command: `uv run python tests/load/analysis_load.py --origin https://resume-analyzer-al3g.onrender.com --token-file "$RESUME_AI_LOAD_TOKEN_FILE" --principals 25000 --rate 5 --seconds 900 --burst-rate 20 --burst-width-seconds 1 --burst-period-seconds 4 --burst-duration-seconds 120 --fixture tests/fixtures/resumes/strong.txt --output load-result.json`.
- Produces machine-checkable release configuration and human evidence fields for Apple, RevenueCat, Render, privacy, and load tests.
- Worker/thread/instance values are changed only to values that passed on the production-like shape.

- [ ] **Step 1: Write failing label-cardinality and privacy tests**

```python
def test_unknown_or_identifier_labels_are_rejected():
    telemetry = Telemetry(sink=FakeSink())
    with pytest.raises(TelemetryContractError):
        telemetry.counter("analysis", {"installation_id": "private"})
    with pytest.raises(TelemetryContractError):
        telemetry.counter("analysis", {"ai_status": "new-unbounded-value"})

def test_sensitive_fixture_markers_never_reach_sink(client, sink):
    submit_v2_reviewed_text(client, resume_text="PRIVATE_MARKER_7f82")
    assert "PRIVATE_MARKER_7f82" not in sink.serialized()
```

- [ ] **Step 2: Run and verify red**

Run: `uv run pytest tests/test_telemetry.py tests/test_privacy.py tests/load/test_analysis_load.py -q`

Expected: FAIL because bounded telemetry and load runner do not exist.

- [ ] **Step 3: Implement the fixed telemetry vocabulary**

Allow only route, status class, plan class, source class, AI status, admission
outcome, provider outcome, and PDF outcome labels defined as frozen sets.
Histograms use fixed admission/scoring/PDF/provider/total buckets. Gauges expose
provider slots, PDF slots, local declared PDF bytes, and Redis health. Unknown
metric names or label values raise before reaching the sink.

- [ ] **Step 4: Implement the fixture-only load runner**

Use `generate_installation_tokens.py --count 25000 --key-stdin` against a
one-run staging signing key, write its output to a mode-0600 file outside the
repository, and configure the isolated staging service with the same one-run
key. The generator refuses production origins and never prints the key. Use
`httpx.AsyncClient` with a bounded connection pool and deterministic pacing,
round-robin the 25,000 tokens, and record only aggregate counts/latencies.
Delete the token file and rotate the staging key immediately after the run.
Refuse fixture paths outside
`tests/fixtures/`; refuse text containing email-like strings, phone-like strings,
or absolute filesystem paths. Exit nonzero unless sustained/burst success is at
least 99%, deterministic p95 is below one second, AI p95 is below ten seconds,
and observed breaker gauges never exceed 48/8/2/20 MiB.

- [ ] **Step 5: Extend retention scanning**

Scan logs, load output, Redis test dump, and emitted metric samples for fixture
markers, absolute paths, token material, and forbidden label names. Keep request
bodies and provider responses out of captured failure output.

- [ ] **Step 6: Run privacy and load unit tests**

Run: `uv run pytest tests/test_telemetry.py tests/test_privacy.py tests/load/test_analysis_load.py -q && node scripts/scan-secrets.mjs && uv run python scripts/verify_no_sensitive_retention.py`

Expected: PASS with no sensitive marker and deterministic exit behavior.

#### Deployment and external evidence

- [ ] **Step 7: Add failing release-config tests**

```python
def test_render_declares_all_25k_secrets_and_multiple_instances(render_config):
    service = render_config["services"][0]
    assert service["numInstances"] >= 2
    assert {item["key"] for item in service["envVars"]} >= {
        "REVENUECAT_SECRET_API_KEY", "REVENUECAT_WEBHOOK_SECRET",
        "APPLE_BUNDLE_ID", "APPLE_TEAM_ID", "APPLE_JWKS_URL",
    }

def test_release_evidence_has_no_unresolved_checked_gate():
    text = Path("docs/release/resume-ai-25k-external-gates.md").read_text()
    assert "- [x]" not in text
    assert "Apple sandbox evidence:" in text
    assert "RevenueCat webhook evidence:" in text
    assert "Render sustained load evidence:" in text
```

- [ ] **Step 8: Run release-config tests and verify red**

Run: `uv run pytest tests/test_release_config.py -q`

Expected: FAIL because the new external-gate document and deployment values are
absent.

- [ ] **Step 9: Declare production environment and measured process shape**

Add the five backend-only RevenueCat/Apple variables to `render.yaml`, set
`APPLE_BUNDLE_ID` to `com.avinashamanchi.resumeai`, and set `APPLE_JWKS_URL` to
`https://appleid.apple.com/auth/keys`. Set `numInstances` to at least 2. Copy
the exact worker/thread values from the passing production-like load run into
both `render.yaml` and `Procfile`; their commands must parse identically under
`scripts/parse_render_commands.py`.

- [ ] **Step 10: Write the evidence checklists**

`resume-ai-25k-external-gates.md` has unchecked boxes and evidence lines for:
Apple agreements/products/SIWA/sandbox/TestFlight; RevenueCat offering,
webhook duplicate/out-of-order/refund/alias/cache expiry; Render Redis headroom,
two-instance sustained/burst tests, outage/rollback drills, secret scan, and
privacy scan. `25k-load-evidence.md` records release SHA, Render service shape,
Redis shape, provider mode, command, output digest, rates, p50/p95/p99, success
counts, breaker maxima, and log-scan receipt.

- [ ] **Step 11: Align public disclosures**

Privacy text states that signed iOS builds send reviewed text, the compatibility
web path may transiently upload a PDF, local versions/jobs can contain sensitive
content and may enter device backups, RevenueCat/Apple process subscription
identity, Apple sign-in is optional, and no local content syncs. Terms retain
the no-employment-guarantee and AI-error disclosures.

- [ ] **Step 12: Run the complete local gate**

Run: `uv run pytest -q && cd mobile && npm test -- --runInBand && npm run typecheck && npm run lint && npm run export:ios`

Expected: all Python, mobile, type, lint, and iOS export checks PASS. The export
does not satisfy native StoreKit, Sign in with Apple, PDFKit/Vision, TestFlight,
RevenueCat webhook, or Render load gates.

- [ ] **Step 13: Run signed-device and external gates**

Run the Swift native harness, signed development build, Apple sandbox matrix,
RevenueCat webhook/alias matrix, and both Task 8 load profiles. Paste only
content-free receipts and output digests into the evidence documents. Leave a
box unchecked when evidence is absent.

- [ ] **Step 14: Commit only after evidence truthfully matches state**

```bash
git add server/telemetry.py server/app.py server/routes.py server/gunicorn_logger.py tests/test_telemetry.py tests/test_privacy.py tests/load/analysis_load.py tests/load/generate_installation_tokens.py tests/load/test_analysis_load.py scripts/verify_no_sensitive_retention.py docs/release/25k-load-evidence.md docs/release/resume-ai-25k-external-gates.md docs/app-store/monetization-setup.md docs/app-store/review-notes-draft.md docs/privacy-policy.md static/privacy.html static/terms.html render.yaml Procfile tests/test_release_config.py
git commit -m "test: gate Resume.AI 25k release evidence"
```

## Final plan verification

- [ ] Map every acceptance criterion in
  `docs/superpowers/specs/2026-08-07-resume-ai-25k-monetization-design.md` to at
  least one task above.
- [ ] Scan the plan for unresolved markers and vague implementation directions; require no matches before execution.
- [ ] Run `git diff --check` and verify no production file changes came from
  planning work.
- [ ] Confirm the implementation branch does not claim external gates passed
  merely because local checks are green.
