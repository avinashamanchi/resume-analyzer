# Resume.AI Pro — Apple purchase setup

Status: `CODED / EXTERNAL CONFIGURATION BLOCKED`. The app has a real RevenueCat purchase, entitlement, cancellation, and restore boundary. Expo Go intentionally shows a preview and cannot complete StoreKit purchases.

## Product contract

| Item | Exact value |
| --- | --- |
| RevenueCat entitlement | `resume_pro` |
| Monthly product | `com.avinashamanchi.resumeai.pro.monthly` |
| Annual product | `com.avinashamanchi.resumeai.pro.annual` |
| Suggested launch price | US $4.99 monthly / US $39.99 annual; confirm every storefront in App Store Connect |
| Access | Unlimited local report history and PDF exports |
| Free plan | Resume analysis, text sharing, and up to 3 locally saved reports |

The UI never hard-codes a selling price. It displays Apple's localized StoreKit price returned through RevenueCat.

## App Store Connect and RevenueCat gate

1. Accept the latest Paid Apps Agreement and complete banking/tax setup in the authorized account.
2. Create one subscription group named `Resume.AI Pro`.
3. Create the monthly and annual auto-renewable products using the exact identifiers above, add localization, price, review screenshot, and review notes, and attach the first subscription to a new app version when Apple requires it.
4. In RevenueCat, connect the Apple app, import both products, attach both to the `resume_pro` entitlement, and add monthly and annual packages to the current offering.
5. Set `EXPO_PUBLIC_REVENUECAT_IOS_API_KEY` to the RevenueCat **public Apple SDK key** in the EAS development/preview/production environments. Do not place an App Store Connect private key or RevenueCat secret API key in the app.
6. Build a signed iOS development build. Verify localized price loading, successful purchase, cancellation, interrupted network, already-owned state, restore after reinstall, and entitlement loss/renewal using Apple sandbox accounts.
7. Repeat the complete flow in the exact TestFlight candidate and provide the subscription screenshot and reviewer path in App Review notes.

Do not submit while the paywall says configuration is unavailable, products do not load, Restore Purchases is unverified, or the Apple and RevenueCat product identifiers differ.
