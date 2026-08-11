import type { VerifiedPlanSnapshot } from '../api/planApi';
import type { WorkspacePlanSnapshot } from './contracts';

const UNKNOWN_FREE_PLAN: WorkspacePlanSnapshot = Object.freeze({
  schemaVersion: 2,
  kind: 'free',
  verifiedUntil: '1970-01-01T00:00:00.000Z',
  entitlementExpiresAt: null,
});

export function workspacePlanFromVerified(
  plan: VerifiedPlanSnapshot | null | undefined,
): WorkspacePlanSnapshot {
  if (plan === null || plan === undefined) return UNKNOWN_FREE_PLAN;
  return Object.freeze({
    schemaVersion: 2,
    kind: plan.kind,
    verifiedUntil: plan.verifiedUntil,
    entitlementExpiresAt: plan.entitlementExpiresAt,
  });
}

export function isVerifiedWorkspacePro(
  plan: VerifiedPlanSnapshot | null | undefined,
  now = new Date(),
): boolean {
  if (plan === null || plan === undefined || plan.kind !== 'pro') return false;
  const verifiedUntil = Date.parse(plan.verifiedUntil);
  const entitlementExpiresAt = plan.entitlementExpiresAt === null
    ? Number.NaN
    : Date.parse(plan.entitlementExpiresAt);
  return Number.isFinite(now.getTime()) &&
    Number.isFinite(verifiedUntil) &&
    Number.isFinite(entitlementExpiresAt) &&
    verifiedUntil > now.getTime() &&
    entitlementExpiresAt > now.getTime();
}
