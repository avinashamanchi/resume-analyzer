# Resume.AI App Store screenshot plan

Status: `BLOCKED — capture only from the accepted TestFlight binary after the production backend and device checklist pass.`

Use the required 6.9-inch iPhone portrait canvas at 1260×2736. Capture real shipping UI with one synthetic resume and synthetic role description. Do not include a real name, employer, school, contact value, device identifier, request identifier, filename, provider token, or fabricated result.

The first three frames carry the clearest product story because they are the most visible in search:

| Order | Caption | Required real screen |
| --- | --- | --- |
| 1 | Review before you send | Source and consent review with synthetic text; provider boundary visible. |
| 2 | See a transparent readiness score | Results screen with real deterministic components from the synthetic fixture. |
| 3 | Turn feedback into stronger bullets | Real generated-feedback section, visibly labeled as AI and reviewed for private text. |
| 4 | Scan, review, then consent | On-device Vision OCR review screen from a synthetic scanned PDF. |
| 5 | Save only when you choose | Results/history UI showing the explicit local-save state. |
| 6 | Share a clean report | Real share action or report preview without exposing the system share recipients. |

Capture rules:

- Keep Resume.AI as the only platform/product shown; no Expo Go, development menu, browser chrome, Android imagery, or third-party brand marks.
- Do not claim exact ATS matching, hiring prediction, guaranteed interviews, professional advice, or provider retention settings that have not been observed.
- Keep captions outside critical app controls and readable at App Store display size.
- Show the app in use in every frame; do not submit a splash-only image.
- Recheck Dynamic Type, VoiceOver labels, dark appearance, safe areas, and icon/launch visuals on the exact binary before capture.
- Store only final redacted images under `docs/release/evidence/` with the TestFlight build number and capture date after they exist.
