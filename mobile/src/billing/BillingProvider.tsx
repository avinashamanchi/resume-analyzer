import React, {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  BillingUnavailableError,
  PurchaseCancelledError,
  type BillingAvailability,
  type BillingPlanStatus,
  type BillingProduct,
  type BillingSnapshot,
} from './revenueCatService';
import { AppleSignInCancelledError } from './appleAccountLinker';

export const RESUME_PRO_ENTITLEMENT = 'resume_pro';
export const RESUME_PRO_PRODUCT_IDS = Object.freeze([
  'com.avinashamanchi.resumeai.pro.monthly',
  'com.avinashamanchi.resumeai.pro.annual',
]);

export interface BillingService {
  load(): Promise<BillingSnapshot>;
  purchase(productId: string): Promise<BillingSnapshot>;
  restore(): Promise<BillingSnapshot>;
  linkApple(): Promise<BillingSnapshot>;
}

export type BillingContextValue = Readonly<{
  availability: BillingAvailability | 'loading';
  planStatus: BillingPlanStatus;
  entitlementActive: boolean;
  allowance: BillingSnapshot['allowance'];
  products: readonly BillingProduct[];
  busy: boolean;
  message: string | null;
  purchase(productId: string): Promise<void>;
  restore(): Promise<void>;
  linkApple(): Promise<void>;
  reload(): Promise<void>;
}>;

const defaultSnapshot: BillingSnapshot = {
  availability: 'configuration',
  planStatus: 'free',
  entitlementActive: false,
  allowance: null,
  products: [],
};

const defaultContext: BillingContextValue = {
  ...defaultSnapshot,
  busy: false,
  message: null,
  purchase: async () => {},
  restore: async () => {},
  linkApple: async () => {},
  reload: async () => {},
};

const BillingContext = createContext<BillingContextValue>(defaultContext);

const defaultService: BillingService = {
  load: async () => defaultSnapshot,
  purchase: async () => { throw new BillingUnavailableError(); },
  restore: async () => { throw new BillingUnavailableError(); },
  linkApple: async () => { throw new BillingUnavailableError(); },
};

export function BillingProvider({
  children,
  service = defaultService,
}: Readonly<{ children: ReactNode; service?: BillingService }>) {
  const [snapshot, setSnapshot] = useState<BillingSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  const operationLocked = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const commit = useCallback((next: BillingSnapshot) => {
    if (mounted.current) setSnapshot(next);
  }, []);

  const reload = useCallback(async () => {
    if (operationLocked.current) return;
    operationLocked.current = true;
    setBusy(true);
    setMessage(null);
    try {
      commit(await service.load());
    } finally {
      operationLocked.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [commit, service]);

  useEffect(() => { void reload(); }, [reload]);

  const purchase = useCallback(async (productId: string) => {
    if (operationLocked.current) return;
    operationLocked.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const next = await service.purchase(productId);
      commit(next);
      if (mounted.current) {
        setMessage(next.entitlementActive
          ? 'Resume.AI Pro is active.'
          : next.planStatus === 'pro_verification_needed'
            ? 'Purchase received. Pro is locked until secure verification succeeds; try again shortly.'
            : 'The purchase did not activate Resume.AI Pro. Try Restore Purchases.');
      }
    } catch (error) {
      if (mounted.current) {
        setMessage(error instanceof PurchaseCancelledError
          ? 'Purchase cancelled. No charge was completed.'
          : 'The purchase could not be completed. You can keep using Free.');
      }
    } finally {
      operationLocked.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [commit, service]);

  const restore = useCallback(async () => {
    if (operationLocked.current) return;
    operationLocked.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const next = await service.restore();
      commit(next);
      if (mounted.current) {
        setMessage(next.entitlementActive
          ? 'Purchases restored. Resume.AI Pro is active.'
          : next.planStatus === 'pro_verification_needed'
            ? 'Purchase found. Pro is locked until secure verification succeeds; try again shortly.'
            : 'No active Resume.AI Pro purchase was found.');
      }
    } catch (error) {
      if (mounted.current) {
        setMessage(error instanceof BillingUnavailableError
          ? 'Restore Purchases is unavailable in this build.'
          : 'Purchases could not be restored. Try again later.');
      }
    } finally {
      operationLocked.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [commit, service]);

  const linkApple = useCallback(async () => {
    if (operationLocked.current) return;
    operationLocked.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const next = await service.linkApple();
      commit(next);
      if (mounted.current) {
        setMessage(next.entitlementActive
          ? 'Apple account linked. Resume.AI Pro was securely restored.'
          : next.planStatus === 'pro_verification_needed'
            ? 'Apple sign-in succeeded, but Pro could not be securely verified yet.'
            : 'Apple sign-in succeeded. No active Resume.AI Pro purchase was found.');
      }
    } catch (error) {
      if (mounted.current) {
        setMessage(error instanceof AppleSignInCancelledError
          ? 'Sign in with Apple was cancelled.'
          : 'Sign in with Apple could not restore purchases. Try again later.');
      }
    } finally {
      operationLocked.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [commit, service]);

  const value = useMemo<BillingContextValue>(() => ({
    availability: snapshot?.availability ?? 'loading',
    planStatus: snapshot?.planStatus ?? 'loading',
    entitlementActive: snapshot?.entitlementActive ?? false,
    allowance: snapshot?.allowance ?? null,
    products: snapshot?.products ?? [],
    busy,
    message,
    purchase,
    restore,
    linkApple,
    reload,
  }), [busy, linkApple, message, purchase, reload, restore, snapshot]);

  return <BillingContext.Provider value={value}>{children}</BillingContext.Provider>;
}

export function useBilling(): BillingContextValue {
  return useContext(BillingContext);
}
