# Resume.AI Pro — Apple purchase setup

Status: `CODED / EXTERNAL CONFIGURATION BLOCKED`. The app has a real RevenueCat purchase, entitlement, cancellation, and restore boundary. Expo Go intentionally shows a preview and cannot complete StoreKit purchases.

## Product contract

| Item | Exact value |
| --- | --- |
| RevenueCat entitlement | `resume_pro` |
| Monthly product | `com.avinashamanchi.resumeai.pro.monthly` |
| Annual product | `com.avinashamanchi.resumeai.pro.annual` |
| Suggested launch price | US $4.99 monthly / US $39.99 annual; confirm every storefront in App Store Connect |
| Pro access | Up to 10,000 local reports, 200 local resume versions, 500 tracked jobs, 100 version snapshots, 100 AI coaching requests per month, and PDF exports |
| Free plan | Up to 3 local reports, 1 local resume version, 3 tracked jobs, deterministic analysis, text sharing, and up to 3 AI coaching requests per month |

The UI never hard-codes a selling price. It displays Apple's localized StoreKit price returned through RevenueCat.

The first App Store release has no account login or Sign in with Apple capability. Purchase and restore are tied to Apple's transaction state and RevenueCat's anonymous app-user identity. Do not re-enable account linking until token revocation and in-app account deletion are implemented and reviewed end to end.

## App Store Connect and RevenueCat gate

1. Accept the latest Paid Apps Agreement and complete banking/tax setup in the authorized account.
2. Create one subscription group named `Resume.AI Pro`.
3. Create the monthly and annual auto-renewable products using the exact identifiers above, add localization, price, review screenshot, and review notes, and attach the first subscription to a new app version when Apple requires it.
4. In RevenueCat, connect the Apple app, import both products, attach both to the `resume_pro` entitlement, and add monthly and annual packages to the current offering.
5. Set `EXPO_PUBLIC_REVENUECAT_IOS_API_KEY` to the RevenueCat **public Apple SDK key** in the EAS development/preview/production environments. Do not place an App Store Connect private key or RevenueCat secret API key in the app.
6. Build a signed iOS development build. Verify localized price loading, successful purchase, cancellation, interrupted network, already-owned state, restore after reinstall, and entitlement loss/renewal using Apple sandbox accounts.
7. Repeat the complete flow in the exact TestFlight candidate and provide the subscription screenshot and reviewer path in App Review notes.
8. Verify that client entitlement state cannot unlock Pro storage or comparison behavior until the backend returns a current signed plan snapshot.

The paywall links directly to Apple subscription management and `https://reportaproblem.apple.com/` for purchase/refund help; Apple determines refund eligibility. Keep offer codes, win-back offers, promoted purchases, Family Sharing, and alternative digital payments disabled for v1. Enabling any of them requires a separate product decision, updated disclosures, App Store configuration, and signed Sandbox/TestFlight evidence.

Do not submit while the paywall says configuration is unavailable, products do not load, Restore Purchases is unverified, or the Apple and RevenueCat product identifiers differ.
