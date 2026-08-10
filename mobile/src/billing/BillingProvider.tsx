import Constants from 'expo-constants';
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
  RevenueCatBillingService,
  type BillingAvailability,
  type BillingProduct,
  type BillingSnapshot,
} from './revenueCatService';

export const RESUME_PRO_ENTITLEMENT = 'resume_pro';
export const RESUME_PRO_PRODUCT_IDS = Object.freeze([
  'com.avinashamanchi.resumeai.pro.monthly',
  'com.avinashamanchi.resumeai.pro.annual',
]);

export interface BillingService {
  load(): Promise<BillingSnapshot>;
  purchase(productId: string): Promise<BillingSnapshot>;
  restore(): Promise<BillingSnapshot>;
}

export type BillingContextValue = Readonly<{
  availability: BillingAvailability | 'loading';
  entitlementActive: boolean;
  products: readonly BillingProduct[];
  busy: boolean;
  message: string | null;
  purchase(productId: string): Promise<void>;
  restore(): Promise<void>;
  reload(): Promise<void>;
}>;

const defaultSnapshot: BillingSnapshot = {
  availability: 'preview',
  entitlementActive: false,
  products: [],
};

const defaultContext: BillingContextValue = {
  ...defaultSnapshot,
  busy: false,
  message: null,
  purchase: async () => {},
  restore: async () => {},
  reload: async () => {},
};

const BillingContext = createContext<BillingContextValue>(defaultContext);

const defaultService = new RevenueCatBillingService({
  apiKey: process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY,
  entitlementId: RESUME_PRO_ENTITLEMENT,
  executionEnvironment: Constants.executionEnvironment,
  productIds: RESUME_PRO_PRODUCT_IDS,
});

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

  const value = useMemo<BillingContextValue>(() => ({
    availability: snapshot?.availability ?? 'loading',
    entitlementActive: snapshot?.entitlementActive ?? false,
    products: snapshot?.products ?? [],
    busy,
    message,
    purchase,
    restore,
    reload,
  }), [busy, message, purchase, reload, restore, snapshot]);

  return <BillingContext.Provider value={value}>{children}</BillingContext.Provider>;
}

export function useBilling(): BillingContextValue {
  return useContext(BillingContext);
}
