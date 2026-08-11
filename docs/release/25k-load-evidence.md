# Resume.AI 25k load evidence

Status: **UNVERIFIED — NO PRODUCTION-LIKE RUN RECORDED**

This is an evidence template, not a passing receipt. Use only an isolated staging target that proves a one-run marker. Token and marker files must be mode 0600, outside the repository, absent from command arguments and output, rotated after the run, and securely deleted after the content-free result is retained.

Release SHA: **UNVERIFIED**

Run UTC window: **UNVERIFIED**

Render service shape: **UNVERIFIED**

Gunicorn workers / threads / instances: **UNVERIFIED**

Redis shape: **UNVERIFIED**

Provider mode: **UNVERIFIED**

Fixture digest: **UNVERIFIED**

Command profile: **UNVERIFIED**

Output SHA-256 digest: **UNVERIFIED**

Identity principals seen: **UNVERIFIED / 25,000 required**

Route and phase counts: **UNVERIFIED**

Status counts and expected-capacity responses: **UNVERIFIED**

p50 / p95 / p99: **UNVERIFIED**

Peak client concurrency: **UNVERIFIED**

Breaker maxima: **UNVERIFIED**

Final active leases: **UNVERIFIED / zero required**

Duplicate analysis IDs: **UNVERIFIED / zero required**

Cross-principal leak count: **UNVERIFIED / zero required**

CPU / memory / connection / Redis headroom: **UNVERIFIED**

Privacy scan digest: **UNVERIFIED**

Rollback and key-rotation receipt: **UNVERIFIED**

Suggested deterministic staging command after generating private one-run files:

```bash
uv run python tests/load/analysis_load.py \
  --origin https://AUTHORIZED-STAGING-ORIGIN \
  --allow-origin https://AUTHORIZED-STAGING-ORIGIN \
  --token-file "$RESUME_AI_LOAD_TOKEN_FILE" \
  --staging-marker-file "$RESUME_AI_LOAD_MARKER_FILE" \
  --principals 25000 --identity-rate 100 \
  --rate 5 --seconds 900 \
  --burst-rate 20 --burst-width-seconds 1 \
  --burst-period-seconds 4 --burst-duration-seconds 120 \
  --fixture tests/fixtures/load/resume-safe.txt \
  --output load-result.json
```

Do not run that command against the production origin. A passing local or mock run does not populate this document.
