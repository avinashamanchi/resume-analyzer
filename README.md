# Resume.AI

Resume.AI is an iOS-first resume feedback app with a deterministic readiness score and optional AI coaching. It accepts pasted text or a PDF, lets the user review what will be sent, requires explicit consent, and keeps saved reports locally only when the user chooses to save them.

The score is coaching feedback, not an employer ATS, hiring decision, employment prediction, or guarantee. AI feedback may be incomplete or wrong.

## Repository layout

- `mobile/` — Expo/React Native iOS app, including the local Apple Vision/PDFKit OCR module used by development and store builds.
- `server/` — Flask API, bounded PDF extraction, deterministic scoring, Groq gateway, installation-token protection, and Redis-backed abuse controls.
- `static/` — browser client plus first-party privacy and support pages.
- `contracts/` — shared response and error schemas.
- `tests/` and `mobile/__tests__/` — backend, browser, privacy, release, and mobile test suites.
- `docs/release/` — release gates and evidence placeholders. A configured candidate is not a published app.

## Local backend

Requirements: Python 3.12, `uv`, and Redis.

```bash
uv sync --frozen
cp .env.example .env
```

Set local values in the untracked `.env`. Provider and signing secrets belong on the server only; never add them to the mobile app or commit them. The production environment fails closed when required settings are absent or invalid.

Run the backend with the same bounded Gunicorn entry point used by the deployment candidate:

```bash
set -a
source .env
set +a
uv run gunicorn 'server.app:create_app()' --bind 127.0.0.1:5000 --workers 1 --threads 4 --timeout 45 --graceful-timeout 30 --keep-alive 5 --max-requests 1000 --max-requests-jitter 100 --access-logfile /dev/null --error-logfile - --log-level warning --logger-class server.gunicorn_logger.ContentFreeGunicornLogger
```

## Local iOS app

Requirements: Node 22 and Expo Go for the first JavaScript-only check.

```bash
cd mobile
npm ci
EXPO_PUBLIC_RESUME_API_URL=https://YOUR-HTTPS-DEVELOPMENT-HOST npx expo start --lan --clear
```

The app accepts only a non-local HTTPS API origin. Expo's `--lan` option delivers the JavaScript bundle over the local network; it does not permit a plaintext API URL. Expo Go can exercise pasted text and readable text-PDF flows against a verified HTTPS backend. Scanned-PDF OCR uses the local Apple module and therefore requires an authorized iOS development build; Expo Go must report that capability as unavailable.

## Verification

```bash
uv run pytest -q
node scripts/scan-secrets.mjs
uv run python scripts/verify_no_sensitive_retention.py

cd mobile
npm ci
npm test -- --runInBand
npm run typecheck
npm run lint
npx --yes expo-doctor@latest
npx expo export --platform ios
npx expo prebuild --platform ios --no-install --clean
git diff --exit-code -- package.json package-lock.json
cd ..
node scripts/check-mobile-audit.mjs
```

## Release status

The repository contains an iOS release candidate, not evidence of App Store publication. Production deployment, provider settings, Apple/EAS signing, a physical-iPhone run, backup/restore behavior, TestFlight, App Review, approval, and the public listing remain blocking gates until they are observed and recorded in `docs/release/`.

Privacy and support drafts are in `docs/privacy-policy.md`, `docs/support.md`, and `docs/app-store/`. Do not use a real resume for release testing or commit credentials, private documents, contact information, device identifiers, request identifiers, or provider secrets.
