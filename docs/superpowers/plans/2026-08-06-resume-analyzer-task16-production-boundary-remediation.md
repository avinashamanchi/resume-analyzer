# Resume.AI Task 16 Production-Boundary Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Implement each task with a focused RED/GREEN cycle, one scoped commit, and an independent review before advancing.

**Goal:** Close the final Task 16 production-readiness review findings without claiming deployment, provider configuration, native-device verification, or App Store publication.

**Architecture:** Keep the existing transient Flask/Gunicorn service and local-first Expo app. Harden configuration and deployment policy at the process boundary, make the retention verifier conservative across callable aliases and project-local imports, make saved/exported-feedback disclosures match the actual contract, route support to a first-party page, and align Expo SDK 57 patch dependencies now that every requested version is published.

**Required base:** `f6bba2c`

**External boundary:** Do not deploy or sync Render, change GitHub repository settings, access provider consoles, submit EAS/App Store builds, or claim that a candidate URL is live. Task 17 must verify the first-party support URL unauthenticated after an authorized production deployment. The current GitHub issue tracker is not a valid support route because public issue creation is restricted.

---

## Task 1: Make production startup and deployment policy content-free and authorization-gated

**Files:**
- Modify: `server/config.py`
- Modify: `render.yaml`
- Modify: `tests/test_config.py`
- Modify: `tests/test_production_boundary.py`

**Required behavior:**
- Malformed `PROVIDER_DEADLINE_SECONDS` and `REQUEST_DEADLINE_SECONDS` raise a generic `ConfigurationError` with no retained cause or context.
- A real Gunicorn startup probe for each malformed deadline uses a private synthetic canary and proves that neither stdout nor stderr contains it.
- Render Blueprint explicitly sets `autoDeployTrigger: off`; production releases remain separately authorized.
- Render's inherited `GUNICORN_CMD_ARGS` cannot enable preloading or change the audited lifecycle. Define the variable explicitly and verify the effective Gunicorn configuration with a Render-equivalent environment.
- Structurally parse the Blueprint and assert the exact policy; do not regex-match YAML.

**Verification:** focused config and production-boundary tests, real Gunicorn startup probes, Blueprint parse, and `gunicorn --check-config`.

**Commit:** `fix: harden production startup policy`

---

## Task 2: Close callable-alias and cross-file retention-verifier gaps

**Files:**
- Modify: `scripts/verify_no_sensitive_retention.py`
- Modify: `tests/test_production_boundary.py`

**Required behavior:**
- Propagate request-derived callable return summaries through direct and chained aliases.
- Resolve project-local `from module import helper` and `import module; module.helper` calls across production Python files.
- Respect overwrite, shadowing, parameter, class, and local safe-callable controls without permitting unresolved sensitive production flows.
- Reject direct/chained alias, imported-helper, module-qualified-helper, and cross-file durable-sink fixtures while accepting overwritten and demonstrably safe controls.
- Keep findings content-free: paths and rule names only, never source values.

**Verification:** focused unsafe/safe mutation matrix, retention verifier on the repository, full production-boundary suite.

**Commit:** `fix: trace cross-file sensitive callables`

---

## Task 3: Make saved-report and export privacy copy match the contract

**Files:**
- Modify: `mobile/src/export/reportHtml.ts`
- Modify: `mobile/app/results/[analysisId].tsx`
- Modify: `mobile/app/privacy.tsx`
- Modify: `mobile/app/support.tsx`
- Modify: `mobile/app/(tabs)/settings.tsx`
- Modify: `static/privacy.html`
- Modify: `static/support.html`
- Modify: `docs/privacy-policy.md`
- Modify: `docs/support.md`
- Modify: `docs/app-store/privacy-draft.md`
- Modify: `docs/app-store/review-notes-draft.md`
- Modify relevant browser/mobile/Python tests.

**Required behavior:**
- State precisely that raw/original PDF bytes, filenames, resume-input fields, job-description-input fields, installation tokens, and request identifiers are not stored in local reports.
- State that generated feedback and bullet drafts may quote, transform, or restate names, contact information, resume content, or job-description content.
- Warn users to review generated feedback before saving, sharing, or allowing it to enter device backups.
- Remove every claim that a saved/exported report contains no source material or identifiers.
- Add an adversarial report fixture containing a synthetic email and private line; prove that the saved record/export includes the feedback exactly and that every user-facing disclosure describes that possibility.

**Verification:** focused export/repository/privacy parity tests, full browser and mobile suites.

**Commit:** `fix: disclose generated report content`

---

## Task 4: Replace the restricted issue tracker and make CI inspect committed changes

**Files:**
- Modify: `mobile/src/controllers/runtime.ts`
- Modify: `static/support.html`
- Modify: `docs/support.md`
- Modify: `docs/privacy-policy.md`
- Modify: `docs/app-store/review-notes-draft.md`
- Modify: `.github/workflows/verify.yml`
- Modify relevant mobile/browser/production-boundary tests.

**Required behavior:**
- Use the first-party candidate support page `https://avinashamanchi.github.io/resume-analyzer/support.html` everywhere instead of the restricted GitHub issue tracker.
- The support page itself provides content-free troubleshooting and clearly states that interactive support is not yet available. It must not direct users to expose resumes or private data.
- Drafts identify the support URL as a release candidate whose anonymous live reachability must be verified after authorized deployment; failure blocks submission.
- CI checks committed whitespace for both pull requests and pushes using event-aware base/head ranges, with a shallow-clone-safe checkout configuration and structural regression tests. It may also check the worktree but must not rely on bare `git diff --check` alone.

**Verification:** URL parity tests, public-page content tests, workflow structure tests, and a temporary-repository CI diff regression fixture.

**Commit:** `fix: make support and CI gates truthful`

---

## Task 5: Align published Expo SDK 57 patch versions

**Files:**
- Modify: `mobile/package.json`
- Modify: `mobile/package-lock.json`

**Required behavior:**
- Using Node 22.23.2, verify the registry publishes `expo@57.0.11`, `expo-file-system@57.0.2`, `expo-router@57.0.11`, `expo-sharing@57.0.10`, and `expo-symbols@57.0.2`.
- Run the SDK-compatible Expo installer; accept only the five expected patch updates and their lockfile consequences.
- Do not use `--force`, dependency exclusions, or unrelated upgrades.
- Re-run tests, typecheck, lint, Expo Doctor, iOS static export, and the high-severity audit gate.
- Record the remaining moderate transitive advisories without hiding them.

**Verification:** `npm ci`, full mobile Jest, typecheck, lint, Expo Doctor 20/20, iOS export, and `npm audit --audit-level=high`.

**Commit:** `chore: align Expo SDK 57 patches`

---

## Task 6: Re-run the complete Task 16 release-candidate gates

Run from the repository root unless noted:

```bash
uv sync --frozen
uv run pytest -q
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" node --test tests/*.test.cjs
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" node scripts/scan-secrets.mjs
uv run python scripts/verify_no_sensitive_retention.py
cd mobile
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" npm ci
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" npm test -- --runInBand
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" npm run typecheck
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" npm run lint
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" npx --yes expo-doctor@latest
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" npx expo export --platform ios
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" npm audit --audit-level=high
```

Also run `git diff --check`, independently review the complete remediation range, and require a clean review before marking Task 16 complete.

**Truthful completion boundary:** A clean Task 16 review means the release-candidate code and local gates are ready for Task 17. It does not verify Render deployment, live TLS/Redis/Groq behavior, Groq ZDR, the first-party support URL, Xcode/CocoaPods, a physical iPhone, backup/restore behavior, signing, TestFlight, App Store submission, approval, or publication.
