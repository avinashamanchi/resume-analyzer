# Resume Analyzer Task 13 PDF Ownership Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two load-bearing Task 13 PDF ownership defects so every failed or colliding native pick either becomes the single authoritative source or remains fail-closed until verified app-cache cleanup.

**Architecture:** Preserve the existing coordinator as the only source-selection and privacy-readiness authority. A document-service staging failure that has already quarantined app-owned cache data is represented to the coordinator as an opaque, content-free abandoned-cleanup obligation; recovery uses the registry's fenced abandoned-cleanup operation because the live lease was intentionally released. A selected PDF that cannot be adopted because another claim with the same request ID is still resolving is routed through the existing exact-lease discard path before the pick completes.

**Tech Stack:** Expo 57.0.10, Expo Router 57.0.10, React Native 0.86.2, strict TypeScript, Jest and Testing Library, Expo FileSystem and DocumentPicker.

## Global Constraints

- Work only in the nested repository `/Users/avi/Documents/ios/resume-analyzer` and the existing isolated worktree `/Users/avi/Documents/ios/resume-analyzer/.worktrees/resume-analyzer-ios-implementation` on branch `codex/resume-analyzer-ios-implementation`.
- iOS/App Store is first; Android work begins only after the iOS listing is live.
- Build a native React Native application; a WebView wrapper is forbidden.
- Use Node 22.23.2 from `/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin` and retain `engines.node` as `>=22.22.0 <23`.
- Accept one source only: a PDF or pasted resume text. The PDF limit remains 10 MiB.
- Require explicit versioned consent before uploading a PDF. Never automatically upload, save, export, or share.
- Never persist, log, network-send, serialize, or expose a PDF URI, filename, request ID, lease, recovery authority, resume text, job text, token, or private error cause.
- `TempFileLease`, pick authority, and cleanup-recovery state remain opaque process-memory authority only.
- Cleanup failure or timeout fails closed with the existing content-free privacy message and blocks every later source/analysis until verified recovery succeeds.
- A stale exact lease must never inspect, delete, revoke, or mark clean a newer owner that reused the same request ID.
- A newer picker, navigation/unmount, lifecycle exit, cancellation, reset, or teardown prevents older work from committing or updating UI.
- Preserve Tasks 9-12 token, API, consent, state-machine, SQLite, startup cleanup, and exact-lease safety invariants.
- Tests and exports are evidence only. Real iPhone/Simulator, VoiceOver, Dynamic Type, signing, TestFlight, and App Store review remain separate gates.

---

### Task 1: Propagate quarantined staging cleanup failure into fail-closed coordinator recovery

**Files:**
- Modify: `mobile/src/controllers/AppController.tsx`
- Modify: `mobile/src/analysis/analysisCoordinator.ts`
- Modify: `mobile/src/analysis/analysisReducer.ts` only if a new event is required; do not duplicate existing `privacyBlocked`/`privacyRecovered` semantics.
- Modify: `mobile/__tests__/appControllerPicker.test.tsx`
- Modify: `mobile/__tests__/analysisCoordinator.test.ts`
- Reference without weakening: `mobile/src/documents/documentSource.ts`
- Reference without weakening: `mobile/src/documents/tempFileRegistry.ts`
- Reference: `mobile/__tests__/documentSource.test.ts`
- Reference: `mobile/__tests__/tempFileRegistry.test.ts`

**Interfaces:**
- Consumes: `DocumentSourceError.category === 'privacy'` and `DocumentSourceError.code === 'cache_cleanup_failed'` as proof that the document/registry layer failed to verify deletion after staging and left the request in fenced abandoned recovery.
- Produces: `AnalysisCommands.failPdfPick(authority: PdfPickAuthority, failure: 'abandoned_cleanup_required'): Promise<void>`.
- Produces: existing `AnalysisCommands.recoverPrivacyCleanup(): Promise<boolean>` recovering both exact live-claim failures and the new abandoned-cleanup obligation.
- Preserves: `AnalysisTempFilesPort.cleanupAbandoned(): Promise<CleanupReceipt>` as the only recovery for this lease-less quarantined state. Do not synthesize or reconstruct a `TempFileLease` after the registry deliberately releases it.

- [ ] **Step 1: Add deterministic failing controller/coordinator tests**

Add tests using the real `AppControllerRoot` and real `AnalysisCoordinator`:

```ts
it('blocks privacy when native staging rejects after unverified cache cleanup', async () => {
  documents.pickPdfForDisplay.mockRejectedValue(
    new DocumentSourceError('privacy', 'cache_cleanup_failed'),
  )

  await expect(actions.pickPdfForDisplay(signal)).rejects.toMatchObject({
    category: 'privacy',
    code: 'cache_cleanup_failed',
  })
  expect(coordinator.getState()).toMatchObject({
    privacyReadiness: 'blocked',
    cleanupPending: true,
    error: { category: 'privacy' },
  })
  await expect(coordinator.commands.selectSource({ kind: 'text', text: 'later resume' }))
    .resolves.toEqual({ committed: false })
})
```

Also assert:

- generic `reset`, foreground return, a new pick, and a later text source do not clear or automatically retry the obligation;
- `recoverPrivacyCleanup()` calls only fenced `cleanupAbandoned()` for this obligation, is bounded by the configured cleanup timeout, and clears readiness only for an exact verified receipt (`failed === 0`, `refused === 0`, `attempted === deleted`);
- a failed, refused, malformed, thrown, or timed-out recovery remains blocked and content-free;
- a successful explicit recovery clears the obligation exactly once and a new foreground pick can then commit;
- validation/picker cancellation errors without `cache_cleanup_failed` do not invent a cleanup obligation;
- the public error, state, JSON serialization, and controller receipt contain no filename, path, request ID, source text, lease, recovery token, or private cause;
- unmount/dispose attempts bounded abandoned cleanup but never reports privacy ready if deletion is unverified.

- [ ] **Step 2: Run the new tests and confirm RED**

Run:

```bash
cd mobile
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" npm test -- --runInBand __tests__/appControllerPicker.test.tsx __tests__/analysisCoordinator.test.ts
```

Expected: the staging-cleanup rejection is currently collapsed to `completePdfPick(authority, null)`, readiness remains `ready`, and explicit abandoned recovery is unavailable.

- [ ] **Step 3: Implement the minimal fail-closed obligation**

Add one content-free failure command to `AnalysisCommands`. In the controller catch path, call it only for the typed `cache_cleanup_failed` privacy error before rethrowing the original safe error. Other errors continue to release the pick with `completePdfPick(authority, null)`.

Inside the coordinator, retain a process-memory boolean/opaque sentinel for the abandoned-cleanup obligation. The failure command must release the matching pick authority, invalidate selection/activation authority, and dispatch the existing privacy-blocked state. `recoverPrivacyCleanup()` must serialize behind mutations, run bounded `cleanupAbandoned()` when the sentinel is set, retain the sentinel on every non-verified outcome, and dispatch `privacyRecovered` only after both the abandoned obligation and every exact-claim cleanup collection are empty. `reset`, lifecycle activation, selection, and generic cleanup must not clear or retry this sentinel.

- [ ] **Step 4: Prove RED/GREEN and run Task 1 regressions**

Temporarily revert only the production fix while retaining the new tests and prove the focused suite fails; restore the fix and prove it passes. Then run:

```bash
cd mobile
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" npm test -- --runInBand __tests__/documentSource.test.ts __tests__/tempFileRegistry.test.ts __tests__/appControllerPicker.test.tsx __tests__/analysisCoordinator.test.ts __tests__/analyzeFlow.test.tsx
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" npm run typecheck
```

Expected: all focused privacy, registry, controller, coordinator, and Analyze tests pass without warnings; TypeScript passes.

- [ ] **Step 5: Commit Task 1**

```bash
git add mobile/src/controllers/AppController.tsx mobile/src/analysis/analysisCoordinator.ts mobile/src/analysis/analysisReducer.ts mobile/__tests__/appControllerPicker.test.tsx mobile/__tests__/analysisCoordinator.test.ts
git commit -m "fix: block on quarantined picker cleanup"
```

---

### Task 2: Close the same-request adoption-in-progress ownership gap

**Files:**
- Modify: `mobile/src/analysis/analysisCoordinator.ts`
- Modify: `mobile/__tests__/appControllerPicker.test.tsx`
- Modify: `mobile/__tests__/analysisCoordinator.test.ts` only if lower-level claim-state coverage is needed.

**Interfaces:**
- Consumes: existing `prepareIncomingSource(source, 'discard')`, `cleanupClaim()`, opaque `TempFileLease`, `PdfPickAuthority`, and `SourceSelectionReceipt` boundaries.
- Produces: `completePdfPick()` guarantees that every non-null staged source ends in exactly one of two states before it resolves: the same exact source is authoritatively committed, or its exact request-ID/lease discard has completed or placed privacy into blocked recovery.
- Preserves: only the latest authorized pick may commit/display; no cleanup is authorized by request ID alone.

- [ ] **Step 1: Add the missing adoption-order RED tests**

Extend the real controller/coordinator picker suite:

```ts
it('does not orphan B when B collides while A ownership inspection is pending', async () => {
  const pickA = actions.pickPdfForDisplay(signalA)
  await ownershipInspectionAStarted
  const pickB = actions.pickPdfForDisplay(signalB)
  resolvePickerB(pdfWithSameRequestIdAndLeaseB)
  await expect(pickB).resolves.toBeNull()
  expect(cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_B)
  expect(cleanupRequest).not.toHaveBeenCalledWith(REQUEST_A, LEASE_A)
  resolveInspectionA(validA)
  await expect(pickA).resolves.toBeNull()
})
```

Cover both B-before-A and A-before-B completions, B cleanup success, refusal, failure, and timeout. Assert:

- a non-committed B is never left without an exact cleanup attempt;
- a refused B cleanup cannot be treated as verified if B might still be staged; it blocks unless the stale-lease receipt proves the lease is no longer authoritative under the coordinator's own claim state;
- B cleanup cannot delete/revoke A, and later A cleanup cannot delete/revoke B;
- if A fully releases before B adoption, B may commit once; otherwise B is exact-lease discarded and returns no display identity;
- no request ID, URI, filename, lease, or private cause enters public state/receipts/logs;
- Task 1's abandoned-cleanup obligation remains blocked and cannot be overwritten by this collision flow.

- [ ] **Step 2: Run the collision tests and confirm RED**

Run:

```bash
cd mobile
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" npm test -- --runInBand __tests__/appControllerPicker.test.tsx __tests__/analysisCoordinator.test.ts
```

Expected: current `prepareIncomingSource(..., 'adopt')` returns no claim during the collision, `selectSource()` returns uncommitted, and B receives no cleanup call.

- [ ] **Step 3: Make non-commit terminal and exact-lease safe**

Keep source adoption serialized by coordinator authority. If `completePdfPick()` receives a non-null source and `selectSource()` does not return a receipt for that exact lease, pass that source through `prepareIncomingSource(source, 'discard')` and bounded exact-lease cleanup before returning. If verified cleanup cannot be established, retain the exact cleanup claim where possible and enter the same fail-closed privacy recovery used by Task 1. Never authorize cleanup from request ID alone, never mutate the current claim map with a colliding discard claim, and never classify `refused: 1` as safe unless the coordinator can prove that exact lease is stale and cannot own bytes.

- [ ] **Step 4: Prove RED/GREEN and run the full remediation gates**

Prove the new collision test fails with only the production fix reverted, restore it, then run:

```bash
cd mobile
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" npm test -- --runInBand __tests__/appControllerPicker.test.tsx __tests__/analysisCoordinator.test.ts __tests__/documentSource.test.ts __tests__/tempFileRegistry.test.ts __tests__/analyzeFlow.test.tsx
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" npm test -- --runInBand
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" npm run typecheck
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" npx expo export --platform ios
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" npx expo export --platform web
PATH="/Users/avi/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH" npx expo-doctor
```

Also run `git diff --check`, inspect the intended eight Expo Router source routes, and confirm the tracked worktree is clean after commit. Do not claim device or App Store gates.

- [ ] **Step 5: Commit Task 2**

```bash
git add mobile/src/analysis/analysisCoordinator.ts mobile/__tests__/appControllerPicker.test.tsx mobile/__tests__/analysisCoordinator.test.ts
git commit -m "fix: terminate colliding picker ownership"
```

---

## Completion Gate

- Both task-scoped independent reviews must be clean.
- A fresh final review must audit `0729a58..HEAD`, both original final-review findings, the original Task 13 fixes, the new remediation ledger, and the complete privacy/ownership state machine.
- Only after that clean review may the original Task 13 ledger receive a new remediation-complete line and Task 14 resume.
- Real iPhone/Simulator picker timing, keyboard, 320×568 at 200% Dynamic Type, VoiceOver observation, native filesystem timing, production API, signing, TestFlight, and App Store acceptance remain explicitly unverified.
